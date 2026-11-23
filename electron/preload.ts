import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('prefly', {
  isDesktop: true,
  platform: process.platform,
  version: process.env.PREFLY_VERSION ?? '',
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  saveBeside: (sourcePath: string, name: string, bytes: Uint8Array) =>
    ipcRenderer.invoke('prefly:save-beside', sourcePath, name, bytes),
  saveAs: (name: string, bytes: Uint8Array) => ipcRenderer.invoke('prefly:save-as', name, bytes),
  reveal: (path: string) => ipcRenderer.send('prefly:reveal', path),
  openFiles: () => ipcRenderer.invoke('prefly:open-files'),
  onOpenFiles: (callback: (files: unknown[]) => void) => {
    const listener = (_event: unknown, files: unknown[]) => callback(files);
    ipcRenderer.on('prefly:files', listener);
    return () => ipcRenderer.removeListener('prefly:files', listener);
  },
});
