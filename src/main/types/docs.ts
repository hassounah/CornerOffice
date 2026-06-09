export interface DocTreeEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  extension: string | null
  size: number | null
  lastModified: string
  isHidden: boolean
  isTeamArtifact: boolean
  isHandoffs: boolean
  isKeyDocument: boolean
  hasChildren: boolean
}

export interface DocTreeResponse {
  dirPath: string
  entries: DocTreeEntry[]
}

export interface DocFileResponse {
  filePath: string
  name: string
  extension: string
  content: string
  size: number
  lastModified: string
}
