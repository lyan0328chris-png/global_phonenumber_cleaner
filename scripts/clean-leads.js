#!/usr/bin/env node

const fs = require("fs/promises");
const path = require("path");
const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");

let XLSX;
let parsePhoneNumberFromString;
try {
  XLSX = require("xlsx");
  ({ parsePhoneNumberFromString } = require("libphonenumber-js/max"));
} catch (error) {
  console.error("缺少本地脚本依赖。请先在仓库目录运行：npm install");
  console.error(error.message || error);
  process.exit(1);
}

const { PhoneCleaner, LeadCleaner } = require("../src/phone-cleaner-core");
PhoneCleaner.setLib({ parsePhoneNumberFromString });

const API_BASE = "https://api.th333.cc";
const WA_TASK_TYPE = "wsValid";
const CLEANED_ROOT_DIR = "Cleanedforcheck";
const STATS_SUMMARY_FILE = "数据统计汇总.csv";
const STATS_HEADERS = [
  "来源名称",
  "leads 获取总数",
  "手机号数（非空值）",
  "漏斗1 手机号非空留存率",
  "有效手机号（清洗后为有效手机号或 landline）",
  "漏斗2 清洗有效留存率",
  "上传+52号码总数",
  "漏斗3 WA待检留存率",
  "WA验证通过数",
  "WA 筛出率",
  "数据质量说明"
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rl = readline.createInterface({ input, output });

  try {
    const inputPath = args.input || await askRequired(rl, "请输入 leads 文件或文件夹路径: ");
    const countryCode = args.country || await askCountry(rl);
    const outputRoot = args.output || await askRequired(rl, "请输入输出根目录路径: ");
    const classificationMode = args.strictClassification ? "strict" : "loose";
    const hasCompleteArgs = Boolean(args.input && args.country && args.output);
    const shouldVerify = args.wa || (!hasCompleteArgs && await askYesNo(rl, "是否清洗后立即做 WhatsApp 校验？(y/N): "));
    const token = shouldVerify ? (args.token || await askRequired(rl, "请输入 TH333 token: ")) : "";

    const files = await collectInputFiles(inputPath);
    if (!files.length) throw new Error("没有找到可处理的 .xlsx 或 .csv 文件");

    for (const filePath of files) {
      await processFile({ filePath, countryCode, outputRoot, shouldVerify, token, classificationMode });
    }
  } finally {
    rl.close();
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--input" || item === "-i") out.input = argv[++i];
    else if (item === "--country" || item === "-c") out.country = argv[++i];
    else if (item === "--output" || item === "-o") out.output = argv[++i];
    else if (item === "--wa") out.wa = true;
    else if (item === "--token") out.token = argv[++i];
    else if (item === "--strict-classification") out.strictClassification = true;
  }
  return out;
}

async function askRequired(rl, message) {
  while (true) {
    const answer = (await rl.question(message)).trim();
    if (answer) return stripQuotes(answer);
  }
}

async function askCountry(rl) {
  const countries = Object.entries(PhoneCleaner.countryMap)
    .map(([code, item]) => `${code}=${item.name}/${item.iso}`)
    .join("  ");
  while (true) {
    const answer = (await rl.question(`请选择国家区号 (${countries}): `)).trim();
    if (PhoneCleaner.getCountryByCode(answer)) return answer;
    console.log("国家区号不支持，请重新输入。");
  }
}

async function askYesNo(rl, message) {
  const answer = (await rl.question(message)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function stripQuotes(value) {
  return String(value || "").replace(/^['"]|['"]$/g, "");
}

async function collectInputFiles(inputPath) {
  const resolved = path.resolve(stripQuotes(inputPath));
  const stat = await fs.stat(resolved);
  if (stat.isFile()) return /\.(xlsx|csv)$/i.test(resolved) ? [resolved] : [];

  const entries = await fs.readdir(resolved);
  return entries
    .filter((name) => /\.(xlsx|csv)$/i.test(name))
    .map((name) => path.join(resolved, name));
}

async function processFile({ filePath, countryCode, outputRoot, shouldVerify, token, classificationMode = "loose" }) {
  const country = PhoneCleaner.getCountryByCode(countryCode);
  if (!country) throw new Error(`不支持的国家区号：${countryCode}`);

  console.log(`\n处理文件: ${filePath}`);
  const rows = readRows(filePath);
  if (!rows.length) {
    console.log("跳过：没有可读取的数据行。");
    return;
  }

  const base = path.basename(filePath).replace(/\.[^.]+$/, "");
  const cleanedRootDir = path.join(path.resolve(stripQuotes(outputRoot)), CLEANED_ROOT_DIR);
  const countryDir = path.join(cleanedRootDir, PhoneCleaner.getCountryFolderName(countryCode));
  await fs.mkdir(countryDir, { recursive: true });
  await fs.mkdir(cleanedRootDir, { recursive: true });

  const columns = Object.keys(rows[0] || {});
  const semanticMap = LeadCleaner.autoDetectSemanticColumns(columns, rows.slice(0, 20));
  const phoneCol = semanticMap.phone_number || LeadCleaner.autoDetectPhoneColumn(columns, rows.slice(0, 20)) || columns[0];
  semanticMap.phone_number = phoneCol;

  const cleanedRows = [];
  let nonEmptyPhoneCount = 0;
  let validMobileOrLandlineCount = 0;
  for (const row of rows) {
    const rawPhone = row[phoneCol];
    if (String(rawPhone ?? "").trim() !== "") nonEmptyPhoneCount += 1;
    const cleaned = PhoneCleaner.cleanOne(row[phoneCol], {
      defaultCountryCode: countryCode,
      defaultCountryISO: country.iso,
      typeFilter: "all",
      outputFormat: "E164",
      classificationMode
    });
    if (LeadCleaner.isValidMobileOrLandline(cleaned)) validMobileOrLandlineCount += 1;
    cleanedRows.push(LeadCleaner.buildExportRow(row, cleaned, semanticMap));
  }

  const dedup = LeadCleaner.deduplicateByStandardPhone(cleanedRows);
  const cleanedPath = path.join(countryDir, `${base}_cleaned.csv`);
  await writeCsv(cleanedPath, dedup.fullRows);
  console.log(`清洗完成: ${cleanedPath}`);

  const waCandidates = LeadCleaner.buildWaCandidateRows(dedup.fullRows, country.iso);
  const waTxtPath = path.join(countryDir, `${base}_wa待校验.txt`);
  await fs.writeFile(waTxtPath, LeadCleaner.buildWaTxt(waCandidates), "utf8");
  console.log(`WA 待校验号码: ${waTxtPath} (${waCandidates.length} 条)`);

  const statsBase = {
    sourceName: path.basename(filePath),
    totalRows: rows.length,
    nonEmptyPhoneCount,
    validMobileOrLandlineCount,
    waUploadCount: waCandidates.length,
    waPassedCount: ""
  };
  const statsPath = path.join(cleanedRootDir, STATS_SUMMARY_FILE);

  if (!shouldVerify) {
    await appendStatsSummary(statsPath, LeadCleaner.buildStatsRow(statsBase));
    return;
  }
  if (!waCandidates.length) {
    console.log("没有符合 WA 校验条件的手机号，跳过提交。");
    await appendStatsSummary(statsPath, LeadCleaner.buildStatsRow(statsBase));
    return;
  }

  const taskName = `${base}_wa_${Date.now()}`;
  const task = await createTask({ token, countryISO: country.iso, taskName, waTxtPath });
  console.log(`TH333 任务已提交: ${task.taskId}`);

  const progress = await waitForTaskFinish({ token, taskId: task.taskId });
  if (progress.taskState !== "Finish") {
    throw new Error(`TH333 任务未完成，状态：${progress.taskState}`);
  }

  const waRows = await downloadResultRows({ token, taskId: task.taskId });
  const waResultRows = LeadCleaner.waRowsToCsvRows(waRows);
  const waPassedCount = waResultRows.filter((row) => String(row.is_wa) === "1").length;
  const waNumberResultPath = path.join(countryDir, `${base}_wa已校验_号码结果.csv`);
  await writeCsv(waNumberResultPath, waResultRows);
  await appendStatsSummary(statsPath, LeadCleaner.buildStatsRow({ ...statsBase, waPassedCount }));

  const merged = LeadCleaner.applyWaResultsToLeads(dedup.fullRows, waRows);
  const mergedPath = path.join(countryDir, `${base}_wa已校验.csv`);
  await writeCsv(mergedPath, merged);
  console.log(`WA 回填完成: ${mergedPath}`);
  console.log(`WA 号码结果: ${waNumberResultPath}`);
}

function readRows(filePath) {
  const workbook = XLSX.readFile(filePath, { raw: false, cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];
  let rows = XLSX.utils.sheet_to_json(sheet, { defval: "", blankrows: false });
  if (!rows.length) {
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false });
    rows = convertAoaToRows(aoa);
  }
  return rows;
}

function convertAoaToRows(aoa) {
  if (!Array.isArray(aoa) || !aoa.length) return [];
  const headerRow = aoa.findIndex((row) => (row || []).some((value) => String(value ?? "").trim() !== ""));
  if (headerRow < 0) return [];
  const headers = (aoa[headerRow] || []).map((value, index) => String(value || `col_${index + 1}`).trim());
  const rows = [];
  for (let i = headerRow + 1; i < aoa.length; i += 1) {
    const source = aoa[i] || [];
    const row = {};
    let hasData = false;
    for (let j = 0; j < headers.length; j += 1) {
      row[headers[j]] = source[j] ?? "";
      if (String(source[j] ?? "").trim()) hasData = true;
    }
    if (hasData) rows.push(row);
  }
  return rows;
}

async function createTask({ token, countryISO, taskName, waTxtPath }) {
  const body = new FormData();
  const bytes = await fs.readFile(waTxtPath);
  body.append("file", new Blob([bytes], { type: "text/plain;charset=utf-8" }), path.basename(waTxtPath));
  body.append("country", countryISO);
  body.append("taskType", WA_TASK_TYPE);
  body.append("taskName", taskName);

  const res = await fetch(`${API_BASE}/api/task/create`, {
    method: "POST",
    headers: { token },
    body
  });
  const json = await res.json();
  if (!res.ok || json.code !== 0) {
    throw new Error(`提交 TH333 任务失败：${json.message || res.statusText}`);
  }
  return json.data || {};
}

async function waitForTaskFinish({ token, taskId }) {
  while (true) {
    await sleep(1200);
    const res = await fetch(`${API_BASE}/api/task/progress?taskId=${encodeURIComponent(taskId)}`, {
      headers: { token }
    });
    const json = await res.json();
    if (!res.ok || json.code !== 0) {
      throw new Error(`查询 TH333 任务失败：${json.message || res.statusText}`);
    }
    const data = json.data || {};
    console.log(`TH333 进度: ${data.taskProgress || 0}/${data.taskTotal || 0} ${data.taskState || ""}`);
    if (["Finish", "Fail", "Close"].includes(data.taskState)) return data;
  }
}

async function downloadResultRows({ token, taskId }) {
  const res = await fetch(`${API_BASE}/api/task/result?taskId=${encodeURIComponent(taskId)}`, {
    headers: { token }
  });
  if (!res.ok) {
    throw new Error(`下载 TH333 结果失败：${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "";
  const isWorkbook = contentType.includes("spreadsheet") || buffer.slice(0, 2).toString("utf8") === "PK";

  if (isWorkbook) {
    const workbook = XLSX.read(buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: "", blankrows: false });
    return LeadCleaner.parseWaResultRows(rows);
  }

  return LeadCleaner.parseWaResultRows(buffer.toString("utf8"));
}

async function writeCsv(filePath, rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const headers = [];
  for (const row of safeRows) {
    for (const key of Object.keys(row || {})) {
      if (!headers.includes(key)) headers.push(key);
    }
  }

  const lines = ["\uFEFF" + headers.map(escapeCsvCell).join(",")];
  for (const row of safeRows) {
    lines.push(headers.map((header) => escapeCsvCell(row[header])).join(","));
  }
  await fs.writeFile(filePath, lines.join("\r\n") + "\r\n", "utf8");
}

async function appendStatsSummary(filePath, row) {
  let existing = "";
  try {
    existing = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const line = STATS_HEADERS.map((header) => escapeCsvCell(row[header])).join(",");
  const hasContent = existing.replace(/^\uFEFF/, "").trim() !== "";
  const prefix = hasContent
    ? existing.replace(/\s*$/, "\r\n")
    : "\uFEFF" + STATS_HEADERS.map(escapeCsvCell).join(",") + "\r\n";
  await fs.writeFile(filePath, prefix + line + "\r\n", "utf8");
}

function escapeCsvCell(value) {
  const text = LeadCleaner.sanitizeTextValue(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
