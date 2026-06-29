#!/usr/bin/env node

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { parsePhoneNumberFromString } = require("libphonenumber-js/max");
const { PhoneCleaner, LeadCleaner } = require("../src/phone-cleaner-core");

PhoneCleaner.setLib({ parsePhoneNumberFromString });

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

const STANDARD_FIELDS = [
  "company_name",
  "industry",
  "company_address",
  "phone_number",
  "company_website",
  "email",
  "standard_phone_number",
  "detected_country",
  "phone_type"
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputDir = args.input;
  const outputDir = args.outputDir || args.output;
  const countryCode = args.country || "52";
  const classificationMode = args.strictClassification ? "strict" : "loose";
  const country = PhoneCleaner.getCountryByCode(countryCode);

  if (!inputDir || !outputDir) {
    throw new Error("用法：node scripts/clean-folder-stream.js --input <源文件夹> --output-dir <最终输出文件夹> --country 52");
  }
  if (!country) throw new Error(`不支持的国家区号：${countryCode}`);

  await fsp.mkdir(outputDir, { recursive: true });
  const files = (await fsp.readdir(inputDir))
    .filter((name) => /\.csv$/i.test(name))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => path.join(inputDir, name));

  if (!files.length) throw new Error("源文件夹内没有 CSV 文件");

  console.log(`源文件夹: ${inputDir}`);
  console.log(`输出文件夹: ${outputDir}`);
  console.log(`待处理 CSV: ${files.length} 个`);

  for (const filePath of files) {
    await processCsvFile({ filePath, outputDir, countryCode, country, classificationMode });
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--input" || item === "-i") out.input = argv[++i];
    else if (item === "--output-dir") out.outputDir = argv[++i];
    else if (item === "--output" || item === "-o") out.output = argv[++i];
    else if (item === "--country" || item === "-c") out.country = argv[++i];
    else if (item === "--strict-classification") out.strictClassification = true;
  }
  return out;
}

async function processCsvFile({ filePath, outputDir, countryCode, country, classificationMode = "loose" }) {
  const sourceName = path.basename(filePath);
  const base = sourceName.replace(/\.[^.]+$/, "");
  const cleanedPath = path.join(outputDir, `${base}_cleaned.csv`);
  const waTxtPath = path.join(outputDir, `${base}_wa待校验.txt`);
  const statsPath = path.join(outputDir, "数据统计汇总.csv");

  console.log(`\n开始清洗: ${sourceName}`);

  const { headers, samples } = await readHeaderAndSamples(filePath, 20);
  if (!headers.length) {
    console.log(`跳过: ${sourceName} 没有表头`);
    return;
  }

  const semanticMap = LeadCleaner.autoDetectSemanticColumns(headers, samples);
  const phoneCol = semanticMap.phone_number || LeadCleaner.autoDetectPhoneColumn(headers, samples) || headers[0];
  semanticMap.phone_number = phoneCol;

  const outputHeaders = buildOutputHeaders(headers);
  const cleanedStream = fs.createWriteStream(cleanedPath, { encoding: "utf8" });
  const waStream = fs.createWriteStream(waTxtPath, { encoding: "utf8" });
  cleanedStream.write("\uFEFF" + outputHeaders.map(escapeCsvCell).join(",") + "\r\n");

  const seenCleanedPhones = new Set();
  const seenWaPhones = new Set();
  let totalRows = 0;
  let writtenRows = 0;
  let nonEmptyPhoneCount = 0;
  let validMobileOrLandlineCount = 0;
  let waUploadCount = 0;
  const qualityProfile = createQualityProfile(country.iso);

  try {
    let isHeader = true;
    for await (const record of parseCsvRecords(filePath)) {
      if (isHeader) {
        isHeader = false;
        continue;
      }

      const sourceRow = recordToRow(headers, record);
      if (!Object.values(sourceRow).some((value) => String(value ?? "").trim() !== "")) continue;

      totalRows += 1;
      const rawPhone = sourceRow[phoneCol];
      if (String(rawPhone ?? "").trim() !== "") nonEmptyPhoneCount += 1;

      const cleaned = PhoneCleaner.cleanOne(rawPhone, {
        defaultCountryCode: countryCode,
        defaultCountryISO: country.iso,
        typeFilter: "all",
        outputFormat: "E164",
        classificationMode
      });

      if (LeadCleaner.isValidMobileOrLandline(cleaned)) validMobileOrLandlineCount += 1;

      const exportRow = LeadCleaner.buildExportRow(sourceRow, cleaned, semanticMap);
      recordQualityProfile(qualityProfile, { sourceRow, rawPhone, cleaned });
      const standardPhone = String(exportRow.standard_phone_number ?? "").trim();
      if (standardPhone) {
        if (seenCleanedPhones.has(standardPhone)) {
          continue;
        }
        seenCleanedPhones.add(standardPhone);
      }

      cleanedStream.write(outputHeaders.map((header) => escapeCsvCell(exportRow[header])).join(",") + "\r\n");
      writtenRows += 1;

      if (isWaCandidate(exportRow, country.iso)) {
        const waPhone = String(exportRow.standard_phone_number ?? "").replace(/^\+/, "").trim();
        if (waPhone && !seenWaPhones.has(waPhone)) {
          seenWaPhones.add(waPhone);
          waStream.write(waPhone + "\n");
          waUploadCount += 1;
        }
      }

      if (totalRows % 100000 === 0) {
        console.log(`进度 ${sourceName}: 已读 ${totalRows.toLocaleString()} 行，写出 ${writtenRows.toLocaleString()} 行`);
      }
    }
  } finally {
    await closeWritable(cleanedStream);
    await closeWritable(waStream);
  }

  await appendStatsSummary(statsPath, LeadCleaner.buildStatsRow({
    sourceName,
    totalRows,
    nonEmptyPhoneCount,
    validMobileOrLandlineCount,
    waUploadCount,
    waPassedCount: "",
    dataQualityNote: buildQualityNote({
      sourceName,
      totalRows,
      nonEmptyPhoneCount,
      validMobileOrLandlineCount,
      waUploadCount,
      countryCode,
      countryISO: country.iso,
      profile: qualityProfile
    })
  }));

  console.log(`完成: ${sourceName}`);
  console.log(`清洗结果: ${cleanedPath}`);
  console.log(`WA 待校验: ${waTxtPath} (${waUploadCount.toLocaleString()} 条)`);
}

async function readHeaderAndSamples(filePath, sampleCount) {
  let headers = [];
  const samples = [];
  let index = 0;
  for await (const record of parseCsvRecords(filePath)) {
    if (index === 0) {
      headers = record.map((value, i) => {
        const text = String(value ?? "").replace(/^\uFEFF/, "").trim();
        return text || `col_${i + 1}`;
      });
    } else if (samples.length < sampleCount) {
      samples.push(recordToRow(headers, record));
    } else {
      break;
    }
    index += 1;
  }
  return { headers, samples };
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
        if (inQuote) {
          pendingQuote = true;
        } else if (!field) {
          inQuote = true;
        } else {
          field += ch;
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
        if (ch === "\r" && chunk[i + 1] === "\n") i += 1;
        yield row;
        row = [];
        continue;
      }

      field += ch;
    }
  }

  if (pendingQuote) {
    pendingQuote = false;
    inQuote = false;
  }
  if (field.length || row.length) {
    row.push(field);
    yield row;
  }
}

function recordToRow(headers, record) {
  const row = {};
  headers.forEach((header, index) => {
    row[header] = record[index] ?? "";
  });
  return row;
}

function buildOutputHeaders(sourceHeaders) {
  const headers = [...STANDARD_FIELDS];
  sourceHeaders.forEach((header) => {
    headers.push(headers.includes(header) ? `${header}__source` : header);
  });
  return headers;
}

function isWaCandidate(row, countryISO) {
  const phone = String(row.standard_phone_number ?? "").trim();
  const detectedCountry = String(row.detected_country || "").trim();
  const phoneType = String(row.phone_type || "").trim();
  return Boolean(phone) &&
    detectedCountry === countryISO &&
    ["MOBILE", "FIXED_LINE_OR_MOBILE", "valid_mobile"].includes(phoneType);
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

function recordQualityProfile(profile, { sourceRow, rawPhone, cleaned }) {
  const rawText = String(rawPhone ?? "");
  const rawDigits = rawText.replace(/\D+/g, "");
  const isValid = LeadCleaner.isValidMobileOrLandline(cleaned);
  const detectedCountry = String(cleaned?.["检测国家"] || "").trim();
  const phoneType = String(cleaned?.["号码类型"] || "").trim();

  if (profile.sampledRows < profile.sampleLimit) {
    profile.sampledRows += 1;
    const maskedCols = findMaskedPhoneColumns(sourceRow);
    if (maskedCols.length) {
      profile.maskedRows += 1;
      maskedCols.forEach((col) => {
        profile.maskedColumns.set(col, (profile.maskedColumns.get(col) || 0) + 1);
      });
    }
  }

  if (rawText.trim() && !isValid) {
    if (isMaskedPhone(rawText)) profile.invalidMasked += 1;
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

async function appendStatsSummary(filePath, row) {
  let existing = "";
  try {
    existing = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const line = STATS_HEADERS.map((header) => escapeCsvCell(row[header])).join(",");
  const hasContent = existing.replace(/^\uFEFF/, "").trim() !== "";
  const prefix = hasContent
    ? existing.replace(/\s*$/, "\r\n")
    : "\uFEFF" + STATS_HEADERS.map(escapeCsvCell).join(",") + "\r\n";
  await fsp.writeFile(filePath, prefix + line + "\r\n", "utf8");
}

function escapeCsvCell(value) {
  const text = LeadCleaner.sanitizeTextValue(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function closeWritable(stream) {
  return new Promise((resolve, reject) => {
    stream.end((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
