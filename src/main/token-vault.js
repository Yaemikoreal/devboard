// GitHub Token 加密封存：基于 Electron safeStorage（Windows DPAPI），仅主进程可用（issue #12）
'use strict';

const { safeStorage } = require('electron');

module.exports = {
  available() {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  },
  seal(plain) {
    return safeStorage.encryptString(String(plain)).toString('base64');
  },
  unseal(b64) {
    try {
      return safeStorage.decryptString(Buffer.from(String(b64), 'base64'));
    } catch {
      return null; // 密文损坏或跨机拷贝：按无 token 处理
    }
  },
};
