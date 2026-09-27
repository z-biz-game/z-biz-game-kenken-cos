// 故意什么都不桥：渲染进程拿不到 Node 能力，桌面版就不会漂移出浏览器版做不到的事。
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('desktopShell', { platform: process.platform, version: '1.0.0' });
