'use strict';
/** 通用解析测试：验证平台能识别各种真实固件的输出格式（不产生任何数据，只转发真实文本）
 *
 * ★ 隔离实例说明（2026-09-28）：
 * 本测试原直连 127.0.0.1:8080 上"正在运行的主服务"。开发板 9-28 起 WiFi 常驻、
 * 以 ~8 帧/秒持续 POST /api/data，主服务里真实帧与测试合成帧互相覆盖 —— 全部断言
 * 必然失败（与 §5.6"板子在线污染测试"同类，只是污染路径从串口自动探测换成了 WiFi）。
 * 现改为自带隔离实例（独立端口 8094 + 测试配置 + 临时数据目录），真实设备无法到达。
 */
const http = require('node:http');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 8094;
const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.platform === 'win32' ? 'D:/tmp/parse-test-data' : '/tmp/parse-test-data';

const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${n}${extra ? '  -> ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const reset = () => fetch(BASE + '/api/disconnect', { method: 'POST' }).then((r) => r.json());
const send = (text) => fetch(BASE + '/api/data', {
  method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text,
}).then((r) => r.json());
const state = () => fetch(BASE + '/api/state').then((r) => r.json());

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const srv = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      CONFIG_PATH: path.join(ROOT, 'test', '.test-config.json'),
      DATA_DIR,
    }),
    stdio: 'ignore',
  });
  await sleep(1300);

  try {
    console.log('通用解析测试\n');

    const cases = [
      ['JSON 对象',            '{"temp":25.5,"hum":60.1}',            { temp: 25.5, hum: 60.1 }],
      ['键=值 逗号分隔',        'Temp=25.3,Hum=60.1',                  { Temp: 25.3, Hum: 60.1 }],
      ['键: 值 带单位',         'Temp: 25.3 C  Hum: 60.1 %',           { Temp: 25.3, Hum: 60.1 }],
      ['键:值 无空格',          'temperature:26.5 humidity:58.2',      { temperature: 26.5, humidity: 58.2 }],
      ['中文键名',              '温度: 26.5 湿度: 58.2',                { 温度: 26.5, 湿度: 58.2 }],
      ['负数与科学计数',        'x=-12.5,y=1.2e3',                     { x: -12.5, y: 1200 }],
    ];

    for (const [name, text, expect] of cases) {
      await reset(); await sleep(120);
      await send(text); await sleep(200);
      const st = await state();
      const ok = st.connected === true &&
        Object.entries(expect).every(([k, v]) => Math.abs((st.fields[k] ?? NaN) - v) < 1e-6);
      check(name, ok, JSON.stringify(st.fields));
    }

    // 不该被当成数据的文本
    const negatives = [
      ['时间戳不被误解析',      'Time: 12:34:56',                      '时间里的数字不能变成传感器值'],
      ['普通日志不被误解析',    '[info] connected in 1234 ms',         '日志里的数字不能变成传感器值'],
      ['纯文本无数值',          'ESP32 ready',                         '无数值不应算数据'],
      ['JSON 但无数值字段',     '{"status":"ok"}',                     '无数值字段不应算数据'],
    ];

    for (const [name, text, why] of negatives) {
      await reset(); await sleep(120);
      await send(text); await sleep(200);
      const st = await state();
      check(`${name}（${why}）`, st.connected === false && Object.keys(st.fields).length === 0,
        JSON.stringify(st.fields));
    }
  } finally {
    srv.kill();
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
