module.exports = {
  appId: 'local.codex.taskspace',
  productName: '任务空间',
  executableName: '任务空间',
  asar: true,
  electronDownload: { checksums: require('electron/checksums.json') },
  npmRebuild: false,
  directories: { output: '.runtime/releases', buildResources: 'assets' },
  files: ['main.cjs', 'lifecycle.cjs', 'policy.cjs', 'preferences.cjs', 'package.json', 'assets/icon.png'],
  extraResources: [
    { from: '../dist', to: 'workbench/dist', filter: ['**/*'] },
    { from: '../server', to: 'workbench/server', filter: ['**/*.ts'] },
    { from: '../shared', to: 'workbench/shared', filter: ['**/*.ts'] },
    { from: 'server-entry.ts', to: 'workbench/desktop/server-entry.ts' },
    { from: '.runtime/workbench-package.json', to: 'workbench/package.json' },
    { from: '.runtime/node', to: 'workbench/runtime', filter: ['node.exe', 'LICENSE'] }
  ],
  win: {
    target: [{ target: 'zip', arch: ['x64'] }, { target: 'nsis', arch: ['x64'] }],
    signExecutable: false,
    icon: 'assets/icon.ico',
    artifactName: 'TaskSpace-${version}-win-${arch}.${ext}'
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    selectPerMachineByDefault: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: '任务空间',
    runAfterFinish: false,
    deleteAppDataOnUninstall: false,
    packElevateHelper: false,
    differentialPackage: false,
    installerLanguages: ['zh_CN', 'en_US'],
    language: '2052',
    artifactName: 'TaskSpace-${version}-Setup-${arch}.exe',
    uninstallDisplayName: '任务空间 ${version}',
    uninstallUrlReadme: 'https://github.com/XueDing2DeMao/codex-task-workbench#readme'
  }
};
