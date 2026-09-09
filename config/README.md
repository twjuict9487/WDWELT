# Configuration layout

已備妥 Node.js、MySQL 與 G2 帳號時，設定 `deployment.json` 後執行 `npm.cmd run setup`。首次互動輸入既有帳號即可建立下列本機憑證；也可由 IT 依模板預先建立。詳見 [既有環境快速安裝](../install/EXISTING-ENVIRONMENT.md)。

- `deployment.json`: non-secret, environment-specific LAN values used by bootstrap and the installer.
- `development.json`: local host/service paths and runtime behavior for development.
- `database.runtime.example.json`: template for the least-privilege application account.
- `database.admin.example.json`: template for migration, backup, and restore credentials.
- `local/`: machine-local credential JSON files. This directory is Git-ignored and protected with Windows ACLs by bootstrap.

Bootstrap creates these local files when needed:

```text
config/local/database.runtime.json
config/local/database.admin.json
```

`runtime/` is intentionally not configuration. It contains generated logs, backups, PID/control records, health state, and maintenance state.
