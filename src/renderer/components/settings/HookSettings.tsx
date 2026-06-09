import React from 'react'
import { PluginStatus } from './PluginStatus'

export function HookSettings(): React.ReactElement {
  return (
    <div className="flex flex-col gap-8">
      <PluginStatus />
    </div>
  )
}
