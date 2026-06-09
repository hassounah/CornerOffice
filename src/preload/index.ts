import { contextBridge } from 'electron'
import { api, ALLOWED_PUSH_CHANNELS } from './api'

contextBridge.exposeInMainWorld('cornerOffice', api)

// Expose allowed channels for runtime introspection (useful for stores / useIpcListener hook)
contextBridge.exposeInMainWorld('cornerOfficeChannels', ALLOWED_PUSH_CHANNELS)
