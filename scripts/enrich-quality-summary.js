#!/usr/bin/env node

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const OUTPUT_HEADERS = [
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
  const outputDir = args.outputDir || args.output;
  const countryCode = args.country || "52";
  const countryISO = args.countryIso || "MX";
  if (!outputDir) throw new Error("用法：node scripts/enrich-quality-summary.js --output-dir <Cleanedforcheck文件夹> --country 52 --country-iso MX");

  const statsPath = path.join(outputDir, "数据统计汇总.csv");
  const summaryRows = parseCsvText(await fsp.readFile(statsPath, "utf8"));
  const enrichedRows = [];

  for (const row of summaryRows) {
    const sourceName = row["来源名称"];
    const base = String(sourceName || "").replace(/\.[^.]+$/, "");
    const cleanedPath = path.join(outputDir, `${base}_cleaned.csv`);
    const profile = await profileCleanedFile(cleanedPath, {
      totalRows: toNumber(row["leads 获取总数"]),
      nonEmptyPhoneCount: toNumber(row["手机号数（非空值）"]),
      validMobileOrLandlineCount: toNumber(row["有效手机号（清洗后为有效手机号或 landline）"]),
      waUploadCount: toNumber(row["上传+52号码总数"]),
      countryCode,
      countryISO
    });
    enrichedRows.push({
      ...row,
      ...buildFunnelFields(row),
      "数据质量说明": buildQualityNote(profile)
    });
    console.log(`已补充质量说明: ${sourceName}`);
  }

  await writeCsv(statsPath, enrichedRows);
  console.log(`完成: ${statsPath}`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--output-dir") out.outputDir = argv[++i];
    else if (item === "--output" || item === "-o") out.output = argv[++i];
    else if (item === "--country" || item === "-c") out.country = argv[++i];
    else if (item === "--country-iso") out.countryIso = argv[++i];
  }
  return out;
}

async function profileCleanedFile(cleanedPath, stats) {
  const profile = createQualityProfile(stats.countryISO);
  const needsFullScan = stats.validMobileOrLandlineCount > 0 || stats.nonEmptyPhoneCount > 0;
  let index = 0;
  let headers = [];

  for await (const record of parseCsvRecords(cleanedPath)) {
    if (index === 0) {
      headers = record.map((value, i) => String(value || `col_${i + 1}`).replace(/^\uFEFF/, "").trim());
      index += 1;
      continue;
    }

    const row = recordToRow(headers, record);
    recordQualityProfile(profile, row);
    index += 1;
    if (!needsFullScan && profile.sampledRows >= profile.sampleLimit) break;
  }

  return { ...stats, profile };
}

function createQualityProfile(targetCountryISO) {
  return {
    targetCountryISO,
    sampleLimit: 2000,
    sampledRows: 0,
    maskedRows: 0,
    maskedColumns: new Map(),
    invalidMasked: 0,
    invalidShort: 0,
    invalidNoDigits: 0,
    countryCounts: new Map(),
    phoneTypeCounts: new Map(),
    targetFixedLine: 0,
    targetOtherNotWa: 0,
    nonTargetValid: 0
  };
}

function recordQualityProfile(profile, row) {
  const rawPhone = String(row.phone_number ?? "");
  const rawDigits = rawPhone.replace(/\D+/g, "");
  const standardPhone = String(row.standard_phone_number ?? "").trim();
  const detectedCountry = String(row.detected_country || "").trim();
  const phoneType = String(row.phone_type || "").trim();
  const isValid = Boolean(standardPhone) && ["MOBILE", "FIXED_LINE", "FIXED_LINE_OR_MOBILE", "valid_mobile", "valid_fixed_line", "valid_ambiguous"].includes(phoneType);

  if (profile.sampledRows < profile.sampleLimit) {
    profile.sampledRows += 1;
    const maskedCols = findMaskedPhoneColumns(row);
    if (maskedCols.length) {
      profile.maskedRows += 1;
      maskedCols.forEach((col) => {
        profile.maskedColumns.set(col, (profile.maskedColumns.get(col) || 0) + 1);
      });
    }
  }

  if (rawPhone.trim() && !isValid) {
    if (isMaskedPhone(rawPhone)) profile.invalidMasked += 1;
    else if (!rawDigits) profile.invalidNoDigits += 1;
    else if (rawDigits.length < 6) profile.invalidShort += 1;
  }

  if (!isValid) return;
  if (detectedCountry) profile.countryCounts.set(detectedCountry, (profile.countryCounts.get(detectedCountry) || 0) + 1);
  if (phoneType) profile.phoneTypeCounts.set(phoneType, (profile.phoneTypeCounts.get(phoneType) || 0) + 1);
  if (detectedCountry !== profile.targetCountryISO) {
    profile.nonTargetValid += 1;
    return;
  }
  if (phoneType === "FIXED_LINE" || phoneType === "valid_fixed_line") profile.targetFixedLine += 1;
  else if (!["MOBILE", "FIXED_LINE_OR_MOBILE", "valid_mobile"].includes(phoneType)) profile.targetOtherNotWa += 1;
}

function buildQualityNote({ totalRows, nonEmptyPhoneCount, validMobileOrLandlineCount, waUploadCount, countryCode, countryISO, profile }) {
  if (!totalRows) return "无数据行。";
  const missingPhone = Math.max(0, totalRows - nonEmptyPhoneCount);
  const invalidPhone = Math.max(0, nonEmptyPhoneCount - validMobileOrLandlineCount);
  const waLoss = Math.max(0, validMobileOrLandlineCount - waUploadCount);
  const maxLoss = Math.max(missingPhone, invalidPhone, waLoss);
  const targetLabel = `${countryISO}/+${countryCode}`;

  if (!maxLoss) return "数据质量较好，清洗后号码基本进入WA待检。";

  if (maxLoss === missingPhone) {
    const maskedInfo = topMapEntry(profile.maskedColumns);
    if (profile.maskedRows > 0 && maskedInfo) {
      return `漏损最多环节：手机号字段完整度；原因：完整手机号缺失 ${missingPhone.toLocaleString()} 条，样本中 ${maskedInfo.key} 等字段多为脱敏/加密号码（如 xxxxx），无完整号码可清洗。`;
    }
    return `漏损最多环节：手机号字段缺失；原因：源文件未提供可用手机号或自动识别的手机号列为空，缺失 ${missingPhone.toLocaleString()} 条。`;
  }

  if (maxLoss === invalidPhone) {
    if (profile.invalidMasked >= invalidPhone * 0.5) {
      return `漏损最多环节：号码清洗校验；原因：原始号码多为脱敏/加密格式（如 xxxxx/*），无法还原完整号码，影响 ${invalidPhone.toLocaleString()} 条。`;
    }
    if (profile.invalidShort >= invalidPhone * 0.5 || profile.invalidNoDigits >= invalidPhone * 0.5) {
      return `漏损最多环节：号码清洗校验；原因：原始号码位数不完整或没有可识别数字，影响 ${invalidPhone.toLocaleString()} 条。`;
    }
    return `漏损最多环节：号码清洗校验；原因：原始号码格式或号段不符合 libphonenumber 校验，影响 ${invalidPhone.toLocaleString()} 条。`;
  }

  const topCountry = topMapEntry(profile.countryCounts);
  if (profile.nonTargetValid >= waLoss * 0.5 && topCountry && topCountry.key !== countryISO) {
    const pct = validMobileOrLandlineCount ? ((topCountry.value / validMobileOrLandlineCount) * 100).toFixed(2) : "0.00";
    return `漏损最多环节：WA待检筛选；原因：有效号码主要检测为 ${topCountry.key}，占有效号码 ${pct}%，不是目标 ${targetLabel}。`;
  }
  if (profile.targetFixedLine >= waLoss * 0.5) {
    return `漏损最多环节：WA待检筛选；原因：目标 ${targetLabel} 的有效号码中固定电话较多，固定电话不进入WA待检，影响 ${profile.targetFixedLine.toLocaleString()} 条。`;
  }
  return `漏损最多环节：WA待检筛选；原因：有效号码中非目标国家或非移动类型较多，未进入WA待检 ${waLoss.toLocaleString()} 条。`;
}

function buildFunnelFields(row) {
  const totalRows = toNumber(row["leads 获取总数"]);
  const nonEmptyPhoneCount = toNumber(row["手机号数（非空值）"]);
  const validMobileOrLandlineCount = toNumber(row["有效手机号（清洗后为有效手机号或 landline）"]);
  const waUploadCount = toNumber(row["上传+52号码总数"]);

  return {
    "漏斗1 手机号非空留存率": formatRate(nonEmptyPhoneCount, totalRows),
    "漏斗2 清洗有效留存率": formatRate(validMobileOrLandlineCount, nonEmptyPhoneCount),
    "漏斗3 WA待检留存率": formatRate(waUploadCount, validMobileOrLandlineCount)
  };
}

function formatRate(numerator, denominator) {
  const den = Number(denominator || 0);
  if (!den) return "";
  return `${((Number(numerator || 0) / den) * 100).toFixed(2)}%`;
}

function topMapEntry(map) {
  let best = null;
  for (const [key, value] of map.entries()) {
    if (!best || value > best.value) best = { key, value };
  }
  return best;
}

function findMaskedPhoneColumns(row) {
  const hits = [];
  for (const [key, value] of Object.entries(row || {})) {
    if (!/phone|tel|mobile|whatsapp|contact|raw|号码|电话|手机/i.test(key)) continue;
    if (isMaskedPhone(value)) hits.push(key);
  }
  return hits;
}

function isMaskedPhone(value) {
  return /x{2,}|\*{2,}|•{2,}|masked|encrypt|hidden|protected|redacted|加密|脱敏/i.test(String(value ?? ""));
}

async function* parseCsvRecords(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 1024 * 1024 });
  let row = [];
  let field = "";
  let inQuote = false;
  let pendingQuote = false;

  for await (const chunk of stream) {
    for (let i = 0; i < chunk.length; i += 1) {
      const ch = chunk[i];
      if (pendingQuote) {
        pendingQuote = false;
        if (ch === '"') {
          field += '"';
          continue;
        }
        inQuote = false;
      }
      if (ch === '"') {
        if (inQuote) pendingQuote = true;
        else if (!field) inQuote = true;
        else field += ch;
        continue;
      }
      if (!inQuote && ch === ",") {
        row.push(field);
        field = "";
        continue;
      }
      if (!inQuote && (ch === "\n" || ch === "\r")) {
        row.push(field);
        field = "";
        if (ch === "\r" && chunk[i + 1] === "\n") i += 1;
        yield row;
        row = [];
        continue;
      }
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    yield row;
  }
}

function parseCsvText(text) {
  const rows = [];
  let headers = null;
  for (const record of parseCsvTextRecords(text)) {
    if (!headers) {
      headers = record.map((value, i) => String(value || `col_${i + 1}`).replace(/^\uFEFF/, "").trim());
      continue;
    }
    rows.push(recordToRow(headers, record));
  }
  return rows;
}

function* parseCsvTextRecords(text) {
  let row = [];
  let field = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuote && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        inQuote = !inQuote;
      }
      continue;
    }
    if (!inQuote && ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (!inQuote && (ch === "\n" || ch === "\r")) {
      row.push(field);
      field = "";
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      if (row.some((v) => String(v).trim() !== "")) yield row;
      row = [];
      continue;
    }
    field += ch;
  }
  if (field.length || row.length) {
    row.push(field);
    if (row.some((v) => String(v).trim() !== "")) yield row;
  }
}

function recordToRow(headers, record) {
  const row = {};
  headers.forEach((header, index) => {
    row[header] = record[index] ?? "";
  });
  return row;
}

async function writeCsv(filePath, rows) {
  const lines = ["\uFEFF" + OUTPUT_HEADERS.map(escapeCsvCell).join(",")];
  rows.forEach((row) => {
    lines.push(OUTPUT_HEADERS.map((header) => escapeCsvCell(row[header])).join(","));
  });
  await fsp.writeFile(filePath, lines.join("\r\n") + "\r\n", "utf8");
}

function escapeCsvCell(value) {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toNumber(value) {
  const n = Number(String(value ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
