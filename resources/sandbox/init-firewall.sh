#!/bin/bash
# Root-only firewall setup (TRD §3.4.4). Usage: init-firewall.sh allowlist|open (domains on stdin).
PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH; HOME=/root; export HOME
set -euo pipefail
umask 077

if [ "$(id -u)" != 0 ]; then echo "init-firewall: must run as root" >&2; exit 1; fi
if [ "$#" -ne 1 ]; then echo "init-firewall: usage: allowlist|open" >&2; exit 1; fi
MODE="$1"
if [ "$MODE" != allowlist ] && [ "$MODE" != open ]; then echo "init-firewall: bad mode" >&2; exit 1; fi

STATE=/run/co
mkdir -p "$STATE"
chmod 0700 "$STATE"

# 2. Save upstream nameservers once per container start (/run is a tmpfs).
IPV4_RE='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
if [ ! -s "$STATE/upstream" ]; then
  : > "$STATE/upstream.tmp"
  while read -r key val _; do
    [ "$key" = nameserver ] || continue
    [[ "$val" =~ $IPV4_RE ]] || continue
    case "$val" in 127.*) echo "init-firewall: refusing loopback upstream $val" >&2; continue ;; esac
    echo "$val" >> "$STATE/upstream.tmp"
  done < /etc/resolv.conf
  if [ ! -s "$STATE/upstream.tmp" ]; then
    rm -f "$STATE/upstream.tmp"
    echo "init-firewall: no usable upstream nameserver" >&2
    exit 3
  fi
  mv "$STATE/upstream.tmp" "$STATE/upstream"
fi
mapfile -t UPSTREAM < "$STATE/upstream"

stop_dnsmasq() {
  if pkill -x dnsmasq; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      pgrep -x dnsmasq >/dev/null || break
      sleep 0.2
    done
  fi
}

# 3. open
if [ "$MODE" = open ]; then
  { for U in "${UPSTREAM[@]}"; do echo "nameserver $U"; done; } > /etc/resolv.conf
  chmod 0644 /etc/resolv.conf
  iptables-nft -P OUTPUT ACCEPT; iptables-nft -F OUTPUT
  ip6tables-nft -P OUTPUT ACCEPT; ip6tables-nft -F OUTPUT
  stop_dnsmasq
  exit 0
fi

# 4a. Read and validate domains before touching any rule.
DOMAIN_RE='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
DOMAINS=()
N=0
while IFS= read -r line || [ -n "$line" ]; do
  N=$((N + 1))
  if [ "$N" -gt 500 ]; then echo "init-firewall: more than 500 domains" >&2; exit 2; fi
  if [ "${#line}" -gt 253 ] || ! [[ "$line" =~ $DOMAIN_RE ]]; then
    echo "init-firewall: invalid domain on line $N" >&2
    exit 2
  fi
  DOMAINS+=("$line")
done

# 4b. dnsmasq allow config.
: > "$STATE/allow.conf.tmp"
for D in "${DOMAINS[@]}"; do
  for U in "${UPSTREAM[@]}"; do echo "server=/$D/$U" >> "$STATE/allow.conf.tmp"; done
  echo "ipset=/$D/co-allow4" >> "$STATE/allow.conf.tmp"
done
chmod 0644 "$STATE/allow.conf.tmp"
mv "$STATE/allow.conf.tmp" "$STATE/allow.conf"

# 4c. ipset.
ipset create co-allow4 hash:ip family inet -exist
ipset flush co-allow4

# 4d. dnsmasq.
stop_dnsmasq
rm -f /var/log/co-dns/queries.log
install -m 0640 -o codns -g codns /dev/null /var/log/co-dns/queries.log
dnsmasq --conf-file=/opt/co-sandbox/dnsmasq-base.conf --conf-file="$STATE/allow.conf"

# 4e. resolv.conf.
echo "nameserver 127.0.0.1" > /etc/resolv.conf
chmod 0644 /etc/resolv.conf

# 4f. OUTPUT chain, DROP policy last.
iptables-nft -F OUTPUT
iptables-nft -A OUTPUT -o lo -j ACCEPT
iptables-nft -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
for U in "${UPSTREAM[@]}"; do
  iptables-nft -A OUTPUT -d "$U" -p udp --dport 53 -m owner --uid-owner codns -j ACCEPT
  iptables-nft -A OUTPUT -d "$U" -p tcp --dport 53 -m owner --uid-owner codns -j ACCEPT
done
iptables-nft -A OUTPUT -m set --match-set co-allow4 dst -j ACCEPT
iptables-nft -A OUTPUT -j REJECT --reject-with icmp-admin-prohibited
iptables-nft -P OUTPUT DROP
ip6tables-nft -F OUTPUT; ip6tables-nft -A OUTPUT -o lo -j ACCEPT; ip6tables-nft -P OUTPUT DROP

# 4g. Self-check.
if ! iptables-nft -S OUTPUT | grep -qx -- '-P OUTPUT DROP'; then
  echo "init-firewall: self-check failed (policy)" >&2; exit 3
fi
if ! dig +short +time=2 @127.0.0.1 api.anthropic.com | grep -Eq "$IPV4_RE"; then
  echo "init-firewall: self-check failed (dns)" >&2; exit 3
fi
exit 0
