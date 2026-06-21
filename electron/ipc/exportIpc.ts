import { ipcMain } from 'electron'
import { ExportService } from '../services/exportService'
import { secure } from '../utils/authGuard'

export function registerExportIpc() {
  ipcMain.handle('export:arpTable', secure(() => ExportService.exportARPTable()))
  ipcMain.handle('export:changes', secure((_e, unacknowledgedOnly?: boolean) => ExportService.exportChanges(unacknowledgedOnly)))
  ipcMain.handle('export:networkUsage', secure((_e, networkId?: number) => ExportService.exportNetworkUsage(networkId)))
}
