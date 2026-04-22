const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onState: (cb) => ipcRenderer.on('state', (_e, state) => cb(state)),
  submitPin: (pin, mode) => ipcRenderer.invoke('submit-pin', pin, mode),
  getAdminData: () => ipcRenderer.invoke('get-admin-data'),
  saveSubjects: (subjects) => ipcRenderer.invoke('admin-save-subjects', subjects),
  awardUnits: (subject, amount, date, note) => ipcRenderer.invoke('admin-award-units', { subject, amount, date, note }),
});
