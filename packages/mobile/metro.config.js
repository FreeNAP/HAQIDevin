// Metro 配置: Expo SDK 52+ 自动处理 monorepo watchFolders
// 自定义解析: markdown-it 依赖 node 核心模块 punycode — 重定向到 npm 同名实现 (RFC 3492 完整实现)
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'punycode' || moduleName === 'node:punycode') {
    try {
      // 注意: require.resolve('punycode') 在 node 中优先命中核心模块返回字符串,
      // 必须通过 package.json 定位 npm 包的真实文件路径
      const path = require('path');
      const pkgJson = require.resolve('punycode/package.json');
      return {
        type: 'sourceFile',
        filePath: path.join(path.dirname(pkgJson), 'punycode.js'),
      };
    } catch {
      // 回退默认解析
    }
  }
  if (defaultResolveRequest) {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
