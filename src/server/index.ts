/** 入口：解析 --host/--port/--strictPort/--data，启动本地服务。 */
import { Store } from './store.js';
import { createApp } from './api.js';
import path from 'node:path';

function argValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(name + '='));
  return eq ? eq.slice(name.length + 1) : undefined;
}

const argv = process.argv.slice(2);
const host = argValue(argv, '--host') ?? '127.0.0.1';
const port = Number(argValue(argv, '--port') ?? process.env.PORT ?? 5230);
const strictPort = argv.includes('--strictPort');
const dataDir = path.resolve(argValue(argv, '--data') ?? process.env.VARIANT_LOOM_DATA ?? path.join(process.cwd(), 'data'));

const store = new Store(dataDir);
const server = createApp(store);

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用${strictPort ? '（--strictPort，退出）' : ''}`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, host, () => {
  console.log(`异文织机已启动: http://${host}:${port}`);
  console.log(`数据目录: ${dataDir}`);
});
