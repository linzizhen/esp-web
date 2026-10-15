/**
 * 被动串口取证：只读不写，专门用于「板子重启」类问题的现场取证。
 *
 * 与 test/listen.js 的区别：listen.js 会主动发送 CRLF/AT/? 试探固件，
 * 那会污染「复位原因」取证（板子可能因收到未知输入而改变行为）。
 * 本脚本严格只读，并额外做两件取证工作：
 *   1) 打时间戳与序号，便于测量两次启动之间的间隔（判断重启频率）；
 *   2) 高亮复位/崩溃特征行（rst:0x… / Guru Meditation / stack overflow /
 *      Brownout / abort / assert），一眼看出是不是重启、哪种重启。
 *
 * 用法: node test/serial-forensics.js [端口] [秒数]
 * 例:   node test/serial-forensics.js COM4 60
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { SerialPort } = require('serialport');

const portPath = process.argv[2] || 'COM4';
const secs = Number(process.argv[3] || 60);

/* 复位/崩溃特征：命中即高亮，并记入事件时间线 */
const RESET_PATTERNS = [
  { re: /rst:0x([0-9a-f]+)\s*\(([^)]+)\)/i, kind: 'RESET', desc: '复位原因' },
  { re: /boot:0x([0-9a-f]+)/i, kind: 'BOOT', desc: '启动模式' },
  { re: /Guru Meditation Error/i, kind: 'PANIC', desc: '内核崩溃' },
  { re: /stack overflow in task (\S+)/i, kind: 'STACK', desc: '任务栈溢出' },
  { re: /Brownout detector was triggered/i, kind: 'BROWNOUT', desc: '欠压复位' },
  { re: /abort\(\) was called/i, kind: 'ABORT', desc: 'abort 调用' },
  { re: /assert failed/i, kind: 'ASSERT', desc: '断言失败' },
  { re: /Core\s+\d+ panic'?ed/i, kind: 'PANIC', desc: '核心 panic' },
  { re: /RTC_SW_CPU_RST/i, kind: 'SWRESET', desc: '软件复位' },
  { re: /ESP-ROM:esp32s3/i, kind: 'ROMBOOT', desc: 'ROM 引导（=刚上电或刚复位）' },
  { re: /ets_?[A-Za-z]*\s+Jul|ets_?[A-Za-z]*\s+\d{4}/i, kind: 'ROMBOOT', desc: 'ROM 引导横幅' },
];

const events = [];
let total = 0;
let buf = '';

const logFile = path.join(__dirname, '..', 'serial-forensics.log');
const out = fs.createWriteStream(logFile, { flags: 'w' });
const write = (s) => { out.write(s + '\n'); };

const p = new SerialPort({ path: portPath, baudRate: 115200, autoOpen: false });

p.on('data', (chunk) => {
  total += chunk.length;
  const text = chunk.toString('utf8');
  buf += text;

  // 逐行处理，保留不完整行到下次
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).replace(/\r$/, '');
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;

    const stamp = new Date().toISOString().slice(11, 23);
    let tag = '';
    for (const { re, kind, desc } of RESET_PATTERNS) {
      const m = re.exec(line);
      if (m) {
        tag = ` <<< [${kind}] ${desc}`;
        events.push({ at: Date.now(), stamp, kind, desc, line: line.trim(), detail: m[1] || m[2] || '' });
        break;
      }
    }
    const rendered = `[${stamp}] ${line}${tag}`;
    console.log(rendered);
    write(rendered);
  }
});

p.on('error', (e) => { console.log('[ERR]', e.message); write('[ERR] ' + e.message); });

p.open((err) => {
  if (err) { console.log('打开失败:', err.message); process.exit(1); }
  console.log(`=== 被动取证：${portPath} @115200，监听 ${secs}s（只读，不发送任何数据）===`);
  console.log(`=== 原始日志将写入 ${logFile} ===\n`);
  // 只读取证：显式不置 DTR/RTS 触发复位，避免把板子重启
  p.set({ dtr: false, rts: false }, () => {});

  setTimeout(() => {
    console.log(`\n==== 共收到 ${total} 字节，${events.length} 个复位/崩溃特征 ====`);
    if (events.length) {
      console.log('\n==== 事件时间线 ====');
      let prev = null;
      for (const e of events) {
        const gap = prev ? `（距上次 ${((e.at - prev) / 1000).toFixed(1)}s）` : '';
        console.log(`  ${e.stamp}  ${e.kind.padEnd(9)} ${e.desc} ${e.detail} ${gap}`);
        console.log(`      ${e.line.slice(0, 120)}`);
        prev = e.at;
      }
    } else {
      console.log('  未捕获到任何复位/崩溃特征（本次窗口内板子稳定）');
    }
    out.end();
    p.close(() => process.exit(0));
  }, secs * 1000);
});
