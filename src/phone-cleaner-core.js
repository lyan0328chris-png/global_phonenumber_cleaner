(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.PhoneCleanerCore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const COUNTRY_MAP = {
    "86": { name: "中国", iso: "CN" },
    "1": { name: "美国", iso: "US" },
    "60": { name: "马来西亚", iso: "MY" },
    "234": { name: "尼日利亚", iso: "NG" },
    "52": { name: "墨西哥", iso: "MX" },
    "84": { name: "越南", iso: "VN" },
    "27": { name: "南非", iso: "ZA" },
    "62": { name: "印尼", iso: "ID" },
    "55": { name: "巴西", iso: "BR" },
    "233": { name: "加纳", iso: "GH" },
    "254": { name: "肯尼亚", iso: "KE" }
  };

  let injectedLib = null;

  const PhoneCleaner = {
    countryMap: COUNTRY_MAP,

    setLib(lib) {
      injectedLib = lib || null;
    },

    getIsoByCode(code) {
      return (this.countryMap[code] || {}).iso || "";
    },

    getCountryByCode(code) {
      return this.countryMap[code] || null;
    },

    getCountryFolderName(code) {
      const country = this.getCountryByCode(code);
      if (!country) return "未指定_UNKNOWN";
      return `${country.name}_${country.iso}_${code}`;
    },

    getCountryCodeFromDigits(digits) {
      const codes = Object.keys(this.countryMap).sort((a, b) => b.length - a.length);
      return codes.find((code) => String(digits || "").startsWith(code)) || "";
    },

    normalizeLocalTrunkPrefix(local, countryCode) {
      const digits = String(local || "");
      if (!countryCode || !digits.startsWith("0")) return digits;
      if (countryCode === "52" || countryCode === "1") return digits;

      if (countryCode === "55") {
        const withoutCarrier = digits.match(/^0\d{2}(\d{10,11})$/);
        if (withoutCarrier) return withoutCarrier[1];
        const withoutTrunk = digits.match(/^0(\d{10,11})$/);
        if (withoutTrunk) return withoutTrunk[1];
        return digits;
      }

      return digits.slice(1);
    },

    normalizeInternationalTrunkPrefix(digits) {
      const countryCode = this.getCountryCodeFromDigits(digits);
      if (!countryCode) return digits;
      const local = String(digits).slice(countryCode.length);
      return countryCode + this.normalizeLocalTrunkPrefix(local, countryCode);
    },

    preprocess(raw, defaultCountryCode) {
      let s = String(raw ?? "").trim()
        .replace(/\s+(?:ext\.?|extension|poste)\s*\d+\s*$/i, "")
        .replace(/\s+x\s+\d+\s*$/i, "")
        .replace(/#\d+\s*$/, "")
        .trim();

      if (/^\d+\.\d+$/.test(s)) s = s.split(".")[0];

      s = s.replace(/^(\+\d+)\s*\(0\)/, "$1 ");
      if (!s) return { str: "", withPlus: false };

      const rawDigitsForMx = s.replace(/\D+/g, "");
      if (defaultCountryCode === "52" && !s.startsWith("+") && rawDigitsForMx.startsWith("0") && !rawDigitsForMx.startsWith("00")) {
        return { str: "", withPlus: false, badFormat: true };
      }

      if (s.startsWith("+")) {
        const digits = s.slice(1).replace(/\D+/g, "");
        if (!digits) return { str: "", withPlus: false };
        const mxNormalized = digits.replace(/^521(\d{10})$/, "52$1");
        const stripped = this.normalizeInternationalTrunkPrefix(mxNormalized);
        return { str: "+" + stripped, withPlus: true };
      }

      const digits = s.replace(/\D+/g, "");
      if (!digits) return { str: "", withPlus: false };

      if (digits.startsWith("00")) {
        const rest = digits.slice(2);
        return rest ? { str: "+" + rest, withPlus: true } : { str: "", withPlus: false };
      }

      let local = digits;
      local = this.normalizeLocalTrunkPrefix(local, defaultCountryCode);
      if (defaultCountryCode === "52" && /^521\d{10}$/.test(local)) local = local.replace(/^521/, "");
      if (!defaultCountryCode && /^521\d{10}$/.test(local)) return { str: local.replace(/^521/, "52"), withPlus: false };

      if (defaultCountryCode) {
        // 直接返回 +CC + local，避免后续再按 ISO 解析导致重复国家码（如 234234…）
        return { str: "+" + defaultCountryCode + local, withPlus: true };
      }
      return { str: local, withPlus: false };
    },

    getLib() {
      if (injectedLib) return injectedLib;
      if (typeof window !== "undefined" && window.libphonenumber) return window.libphonenumber;
      if (typeof globalThis !== "undefined" && globalThis.libphonenumber) return globalThis.libphonenumber;
      return {};
    },

    formatNumber(parsed, fmt) {
      try {
        let result;
        if (fmt === "INTERNATIONAL") result = parsed.formatInternational();
        else if (fmt === "NATIONAL") result = parsed.formatNational();
        else result = parsed.format("E.164");
        return result.replace(/^\+/, "");
      } catch (_) {
        return String(parsed.number || "").replace(/^\+/, "");
      }
    },

    classifyPhoneType(phoneType, strictClassification) {
      if (!strictClassification) return phoneType || "";
      const map = {
        MOBILE: "valid_mobile",
        FIXED_LINE: "valid_fixed_line",
        FIXED_LINE_OR_MOBILE: "valid_ambiguous",
        VOIP: "valid_voip",
        TOLL_FREE: "valid_toll_free",
        PREMIUM_RATE: "valid_premium_rate",
        SHARED_COST: "valid_shared_cost",
        PERSONAL_NUMBER: "valid_personal_number",
        PAGER: "valid_pager",
        UAN: "valid_uan",
        VOICEMAIL: "valid_voicemail"
      };
      return map[phoneType] || (phoneType ? `valid_${String(phoneType).toLowerCase()}` : "valid_unknown");
    },

    fallbackMexicoNumber(rawValue, defaultCountryCode, outputFormat, strictClassification = false) {
      const raw = String(rawValue ?? "");
      const candidates = [];
      const intlMatches = raw.matchAll(/\+?\s*52[\s\-‐-―()]*1?[\s\-‐-―()]*(\d[\d\s\-‐-―()]{8,}\d)/g);
      for (const m of intlMatches) {
        const local = String(m[1] || "").replace(/\D+/g, "");
        if (local.length === 10) candidates.push(local);
      }
      const digits = raw.replace(/\D+/g, "");
      if (/^521\d{10}$/.test(digits)) candidates.push(digits.slice(3));
      if (/^52\d{10}$/.test(digits)) candidates.push(digits.slice(2));
      if (defaultCountryCode === "52" && /^[1-9]\d{9}$/.test(digits)) candidates.push(digits);
      const local = candidates.find((x) => /^\d{10}$/.test(x));
      if (!local) return null;
      const e164 = "52" + local;
      const formatted = outputFormat === "INTERNATIONAL"
        ? `52 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`
        : outputFormat === "NATIONAL"
          ? `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`
          : e164;
      return {
        "原始号码": rawValue,
        "清洗后号码": formatted,
        "状态": "有效(MX)",
        "检测国家": "MX",
        "号码类型": this.classifyPhoneType("FIXED_LINE_OR_MOBILE", strictClassification)
      };
    },

    _scoreResult(r) {
      if (!String(r["状态"] || "").startsWith("有效")) return 0;
      const t = r["号码类型"] || "";
      if (["MOBILE", "valid_mobile"].includes(t)) return 4;
      if (["FIXED_LINE", "valid_fixed_line"].includes(t)) return 3;
      if (["FIXED_LINE_OR_MOBILE", "valid_ambiguous"].includes(t)) return 2;
      if (t) return 2;
      return 1;
    },

    extractPhoneCandidatesFromRaw(rawStr) {
      const s = String(rawStr ?? "").replace(/\\\+/g, "+").trim();
      if (!s) return [];
      const coarse = s
        .split(/[\/,;|\n、]/)
        .flatMap((seg) => seg.trim().split(/\s+(?=\+\s*\d)/))
        .map((x) => x.trim())
        .filter(Boolean);
      const result = [];
      for (const seg of coarse) result.push(...this._normalizePhoneSegment(seg));
      return result.length ? result : [s];
    },

    _normalizePhoneSegment(seg) {
      const pieces = seg
        .replace(/[A-Za-z\u4e00-\u9fff]+/g, "\x00")
        .replace(/[^\d+\s()\-‐-―\x00]/g, " ")
        .split("\x00")
        .map((x) => x.replace(/\s+/g, " ").trim())
        .filter((x) => /\d/.test(x));
      if (!pieces.length) return [seg];

      const result = [];
      for (let piece of pieces) {
        piece = piece.replace(/(\+\d{1,3})\s*\(([1-9]\d{0,3})\)\s*/g, "$1$2 ").trim();
        const allDigits = piece.replace(/\D/g, "");

        let handled = false;
        if (allDigits.length >= 12 && allDigits.length % 2 === 0) {
          const half = allDigits.length / 2;
          if (allDigits.slice(0, half) === allDigits.slice(half)) {
            result.push(piece.startsWith("+") ? "+" + allDigits.slice(0, half) : allDigits.slice(0, half));
            handled = true;
          }
        }

        if (!handled) {
          for (let dl = 10; dl >= 6; dl -= 1) {
            if (allDigits.length >= dl * 2 &&
                allDigits.slice(-dl) === allDigits.slice(-(dl * 2), -dl)) {
              result.push(piece.startsWith("+") ? "+" + allDigits.slice(0, -dl) : allDigits.slice(0, -dl));
              handled = true;
              break;
            }
          }
        }
        if (handled) continue;

        if (piece.startsWith("+")) {
          if (allDigits.length >= 6) result.push(piece);
          continue;
        }
        const words = piece.split(/\s+/);
        const groups = [];
        let cur = "";
        for (const w of words) {
          if (!w) continue;
          if (cur && /^0/.test(w) && cur.replace(/\D/g, "").length >= 7) {
            groups.push(cur.trim());
            cur = w;
          } else {
            cur = cur ? cur + " " + w : w;
          }
        }
        if (cur.trim()) groups.push(cur.trim());
        result.push(...groups.filter((g) => g.replace(/\D/g, "").length >= 6));
      }
      return result.filter(Boolean);
    },

    cleanOne(rawValue, opts = {}) {
      const {
        defaultCountryCode = "",
        defaultCountryISO = "",
        typeFilter = "all",
        outputFormat = "E164",
        classificationMode = "loose"
      } = opts;
      const strictClassification = classificationMode === "strict";

      const candidates = this.extractPhoneCandidatesFromRaw(rawValue);
      if (candidates.length > 1) {
        let best = null;
        let bestScore = -1;
        for (const c of candidates) {
          const res = this.cleanOne(c, opts);
          const score = this._scoreResult(res);
          if (score > bestScore) {
            bestScore = score;
            best = res;
          }
          if (bestScore >= 4) break;
        }
        return best || this.cleanOne(candidates[0], opts);
      }

      const original = candidates[0] || "";
      const empty = { "原始号码": original, "清洗后号码": "", "检测国家": "", "号码类型": strictClassification ? "invalid" : "" };

      const { str: preprocessed, withPlus, badFormat } = this.preprocess(original, defaultCountryCode);
      if (badFormat) {
        return { ...empty, "状态": "无效-bad format" };
      }
      if (!preprocessed) {
        return { ...empty, "状态": "无效-空号" };
      }

      const lib = this.getLib();
      const parseFn = lib.parsePhoneNumberFromString;
      if (typeof parseFn !== "function") {
        return { ...empty, "状态": "无效-库未加载" };
      }

      let parsed = null;

      if (!parsed && defaultCountryISO) {
        const rawDigits = String(original).replace(/\D+/g, "");
        if (rawDigits) {
          try {
            const p = parseFn(rawDigits, defaultCountryISO);
            if (p && p.isValid()) parsed = p;
          } catch (_) {}
        }
      }

      if (!parsed && !withPlus && !defaultCountryCode) {
        const rawDigits = String(original).replace(/\D+/g, "");
        if (rawDigits && !rawDigits.startsWith("0")) {
          try {
            const p = parseFn("+" + rawDigits);
            const accept = (pp) => (strictClassification || defaultCountryISO === "NG") ? pp.isValid() : (pp.isValid() || pp.isPossible());
            if (p && accept(p)) parsed = p;
          } catch (_) {}
        }
      }

      if (!parsed) {
        const attemptStr = withPlus ? preprocessed : "+" + preprocessed;
        try {
          const p = parseFn(attemptStr);
          const accept = (pp) => (strictClassification || defaultCountryISO === "NG") ? pp.isValid() : (pp.isValid() || pp.isPossible());
          if (p && accept(p)) parsed = p;
        } catch (_) {}
      }

      if (!parsed && defaultCountryISO) {
        try {
          const p = parseFn(preprocessed, defaultCountryISO);
          const accept = (pp) => (strictClassification || defaultCountryISO === "NG") ? pp.isValid() : (pp.isValid() || pp.isPossible());
          if (p && accept(p)) parsed = p;
        } catch (_) {}
      }

      if (!parsed) {
        const mxFallback = this.fallbackMexicoNumber(original, defaultCountryCode, outputFormat, strictClassification);
        if (mxFallback) return mxFallback;
        return { ...empty, "状态": "无效-号段不符" };
      }

      const phoneType = parsed.getType() || "";
      const countryISO = parsed.country || "";
      if (countryISO === "MX" && !phoneType) {
        const mxFallback = this.fallbackMexicoNumber(original, defaultCountryCode, outputFormat, strictClassification);
        if (mxFallback) return mxFallback;
      }

      const isMobile = strictClassification ? phoneType === "MOBILE" : ["MOBILE", "FIXED_LINE_OR_MOBILE"].includes(phoneType);
      const isFixed = strictClassification ? phoneType === "FIXED_LINE" : ["FIXED_LINE", "FIXED_LINE_OR_MOBILE"].includes(phoneType);

      if (typeFilter === "mobile" && !isMobile) {
        return { ...empty, "状态": `无效-非手机号(${phoneType || "未知"})`, "检测国家": countryISO, "号码类型": this.classifyPhoneType(phoneType, strictClassification) };
      }
      if (typeFilter === "fixed" && !isFixed) {
        return { ...empty, "状态": `无效-非固话(${phoneType || "未知"})`, "检测国家": countryISO, "号码类型": this.classifyPhoneType(phoneType, strictClassification) };
      }
      if (typeFilter === "mobile_and_fixed" && !isMobile && !isFixed) {
        return { ...empty, "状态": `无效-非手机/固话(${phoneType || "未知"})`, "检测国家": countryISO, "号码类型": this.classifyPhoneType(phoneType, strictClassification) };
      }

      const formatted = this.formatNumber(parsed, outputFormat);

      return {
        "原始号码": original,
        "清洗后号码": formatted,
        "状态": `有效(${countryISO})`,
        "检测国家": countryISO,
        "号码类型": this.classifyPhoneType(phoneType, strictClassification)
      };
    }
  };

  const LeadCleaner = {
    isValidMobileOrLandline(cleaned) {
      const status = String(cleaned?.["状态"] || "");
      const phoneType = String(cleaned?.["号码类型"] || "").trim();
      return status.startsWith("有效") && ["MOBILE", "FIXED_LINE", "FIXED_LINE_OR_MOBILE", "valid_mobile", "valid_fixed_line", "valid_ambiguous"].includes(phoneType);
    },

    buildStatsRow(stats) {
      const waUploadCount = Number(stats.waUploadCount || 0);
      const waPassedRaw = stats.waPassedCount;
      const hasWaResult = waPassedRaw !== null && waPassedRaw !== undefined && waPassedRaw !== "";
      const waPassedCount = hasWaResult ? Number(waPassedRaw || 0) : "";
      const rate = hasWaResult && waUploadCount > 0
        ? `${((Number(waPassedRaw || 0) / waUploadCount) * 100).toFixed(2)}%`
        : "";
      const totalRows = Number(stats.totalRows || 0);
      const nonEmptyPhoneCount = Number(stats.nonEmptyPhoneCount || 0);
      const validMobileOrLandlineCount = Number(stats.validMobileOrLandlineCount || 0);

      return {
        "来源名称": String(stats.sourceName || ""),
        "leads 获取总数": totalRows,
        "手机号数（非空值）": nonEmptyPhoneCount,
        "漏斗1 手机号非空留存率": formatRate(nonEmptyPhoneCount, totalRows),
        "有效手机号（清洗后为有效手机号或 landline）": validMobileOrLandlineCount,
        "漏斗2 清洗有效留存率": formatRate(validMobileOrLandlineCount, nonEmptyPhoneCount),
        "上传+52号码总数": waUploadCount,
        "漏斗3 WA待检留存率": formatRate(waUploadCount, validMobileOrLandlineCount),
        "WA验证通过数": waPassedCount,
        "WA 筛出率": rate,
        "数据质量说明": String(stats.dataQualityNote || stats.qualityNote || "")
      };
    },

    sanitizeTextValue(value) {
      return String(value ?? "")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
        .replace(/[\u200D\uFE0E\uFE0F]/g, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    },

    detectFieldColumn(columns, sampleRows, rules) {
      for (const col of columns) {
        if (rules.headerKeywords.some((re) => re.test(col))) return col;
      }

      let bestCol = "";
      let bestScore = 0;
      for (const col of columns) {
        const score = sampleRows.reduce((acc, row) => {
          const value = String(row[col] ?? "").trim();
          if (!value) return acc;
          return acc + (rules.valueHints.some((re) => re.test(value)) ? 1 : 0);
        }, 0);
        if (score > bestScore) {
          bestScore = score;
          bestCol = col;
        }
      }
      return bestScore > 0 ? bestCol : "";
    },

    detectIndustryColumn(columns, sampleRows) {
      const priorityRules = [
        [/^行业$/i, /行业/, /industry/i, /sector/i, /vertical/i],
        [/企业\s*type/i, /企业类型/, /公司类型/, /type/i, /business\s*type/i],
        [/企业描述/, /公司描述/, /主营/, /description/i, /profile/i]
      ];

      for (const group of priorityRules) {
        const hit = columns.find((col) => group.some((re) => re.test(col)));
        if (hit) return hit;
      }

      return this.detectFieldColumn(columns, sampleRows, {
        headerKeywords: [/industry/i, /sector/i, /vertical/i, /行业/, /赛道/, /企业类型/, /type/i, /描述/, /profile/i],
        valueHints: [/manufactur|retail|tech|software|finance|education|medical|logistics|教育|医疗|制造|电商|物流|贸易/i]
      });
    },

    autoDetectPhoneColumn(columns, sampleRows) {
      const keywords = [/phone/i, /mobile/i, /tel/i, /手机号/, /手机/, /电话/, /号码/];
      for (const c of columns) {
        if (keywords.some((re) => re.test(c))) return c;
      }

      let best = null;
      let bestScore = -1;
      for (const c of columns) {
        const score = sampleRows.reduce((acc, row) => {
          const v = String(row[c] ?? "");
          const digits = v.replace(/\D+/g, "");
          return acc + (digits.length >= 8 ? 1 : 0);
        }, 0);
        if (score > bestScore) {
          best = c;
          bestScore = score;
        }
      }
      return best;
    },

    autoDetectSemanticColumns(columns, sampleRows) {
      return {
        company_name: this.detectFieldColumn(columns, sampleRows, {
          headerKeywords: [/company/i, /company.?name/i, /企业名/, /公司名/, /公司名称/, /客户名/, /商户名/],
          valueHints: [/有限公司/, /集团/, /公司/, /corp/i, /inc/i, /ltd/i]
        }),
        industry: this.detectIndustryColumn(columns, sampleRows),
        company_address: this.detectFieldColumn(columns, sampleRows, {
          headerKeywords: [/address/i, /addr/i, /location/i, /街道/, /地址/, /办公地/, /所在地/],
          valueHints: [/road|street|ave|city|district|no\.|#|省|市|区|路|号/i]
        }),
        phone_number: this.autoDetectPhoneColumn(columns, sampleRows),
        company_website: this.detectFieldColumn(columns, sampleRows, {
          headerKeywords: [/website/i, /site/i, /url/i, /web/i, /官网/, /网址/, /链接/],
          valueHints: [/https?:\/\//i, /www\./i, /\.[a-z]{2,}$/i]
        }),
        email: this.detectFieldColumn(columns, sampleRows, {
          headerKeywords: [/email/i, /mail/i, /邮箱/],
          valueHints: [/@/]
        })
      };
    },

    buildExportRow(sourceRow, cleaned, semanticMap = {}) {
      const standardFields = {
        company_name: semanticMap.company_name ? String(sourceRow[semanticMap.company_name] ?? "") : "",
        industry: semanticMap.industry ? String(sourceRow[semanticMap.industry] ?? "") : "",
        company_address: semanticMap.company_address ? String(sourceRow[semanticMap.company_address] ?? "") : "",
        phone_number: semanticMap.phone_number ? String(sourceRow[semanticMap.phone_number] ?? "") : "",
        company_website: semanticMap.company_website ? String(sourceRow[semanticMap.company_website] ?? "") : "",
        email: semanticMap.email ? String(sourceRow[semanticMap.email] ?? "") : "",
        standard_phone_number: String(cleaned["清洗后号码"] ?? ""),
        detected_country: String(cleaned["检测国家"] ?? ""),
        phone_type: String(cleaned["号码类型"] ?? "")
      };

      const merged = { ...standardFields };
      Object.keys(sourceRow || {}).forEach((key) => {
        if (key in merged) {
          merged[`${key}__source`] = sourceRow[key];
          return;
        }
        merged[key] = sourceRow[key];
      });
      return merged;
    },

    deduplicateByStandardPhone(rows) {
      const seen = new Set();
      const fullRows = [];
      let duplicateRemoved = 0;

      for (const row of rows) {
        const standardPhone = String(row.standard_phone_number ?? "").trim();
        if (!standardPhone) {
          fullRows.push(row);
          continue;
        }
        if (seen.has(standardPhone)) {
          duplicateRemoved += 1;
          continue;
        }
        seen.add(standardPhone);
        fullRows.push(row);
      }

      return { fullRows, uniqueCount: seen.size, duplicateRemoved };
    },

    buildWaCandidateRows(rows, countryISO) {
      const allowedTypes = new Set(["MOBILE", "FIXED_LINE_OR_MOBILE", "valid_mobile"]);
      const seen = new Set();
      const result = [];

      for (const row of rows || []) {
        const phone = String(row.standard_phone_number ?? "").replace(/^\+/, "").trim();
        if (!phone) continue;
        if (countryISO && String(row.detected_country || "").trim() !== countryISO) continue;
        if (!allowedTypes.has(String(row.phone_type || "").trim())) continue;
        if (seen.has(phone)) continue;
        seen.add(phone);
        result.push({ Number: phone });
      }

      return result;
    },

    buildWaTxt(rows) {
      return rows.map((row) => String(row.Number ?? "").replace(/^\+/, "").trim()).filter(Boolean).join("\n") + "\n";
    },

    parseWaResultRows(input) {
      if (Array.isArray(input)) return normalizeWaRows(input);
      const text = String(input ?? "").replace(/^\uFEFF/, "");
      if (!text.trim()) return [];
      const firstLine = text.split(/\r?\n/).find((line) => line.trim()) || "";
      const delimiter = detectDelimiter(firstLine);
      const rows = parseDelimited(text, delimiter);
      return normalizeWaRows(rows);
    },

    applyWaResultsToLeads(leadsRows, waRows) {
      const map = new Map();
      for (const row of waRows || []) {
        const number = String(row.Number ?? row.number ?? row.phone ?? "").replace(/\D+/g, "");
        if (!number) continue;
        const activated = String(row.activated ?? row.Activated ?? row.is_wa ?? "").trim().toLowerCase();
        const isWa = activated === "yes" || activated === "1" || activated === "true" ? "1"
          : activated === "no" || activated === "0" || activated === "false" ? "0"
            : "";
        map.set(number, isWa);
      }

      return (leadsRows || []).map((row) => {
        const phone = String(row.standard_phone_number ?? "").replace(/\D+/g, "");
        const value = map.has(phone) ? map.get(phone) : "";
        return { ...row, is_wa: value };
      });
    },

    waRowsToCsvRows(waRows) {
      return (waRows || []).map((row) => {
        const number = String(row.Number ?? row.number ?? "").replace(/\D+/g, "");
        const activated = String(row.activated ?? row.Activated ?? "").trim().toLowerCase();
        const isWa = activated === "yes" ? "1" : activated === "no" ? "0" : "";
        return { Number: number, activated, is_wa: isWa };
      });
    }
  };

  function detectDelimiter(line) {
    const candidates = [",", "\t", ";", "|"];
    let best = ",";
    let bestCount = -1;
    for (const d of candidates) {
      const count = String(line || "").split(d).length - 1;
      if (count > bestCount) {
        best = d;
        bestCount = count;
      }
    }
    return best;
  }

  function parseDelimited(text, delimiter) {
    const rows = [];
    let header = null;
    let cells = [];
    let field = "";
    let inQuote = false;

    const pushField = () => {
      cells.push(field);
      field = "";
    };

    const finalizeRow = () => {
      pushField();
      const hasAny = cells.some((c) => String(c ?? "").trim() !== "");
      if (!hasAny) {
        cells = [];
        return;
      }
      if (!header) {
        header = cells.map((h, i) => String(h || `col_${i + 1}`).trim());
        cells = [];
        return;
      }
      const obj = {};
      for (let i = 0; i < header.length; i += 1) {
        obj[header[i]] = String(cells[i] ?? "").trim();
      }
      rows.push(obj);
      cells = [];
    };

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
      if (!inQuote && ch === delimiter) {
        pushField();
        continue;
      }
      if (!inQuote && (ch === "\n" || ch === "\r")) {
        if (ch === "\r" && text[i + 1] === "\n") i += 1;
        finalizeRow();
        continue;
      }
      field += ch;
    }
    if (field.length || cells.length) finalizeRow();
    return rows;
  }

  function normalizeWaRows(rows) {
    return (rows || []).map((row) => {
      const out = {};
      for (const [key, value] of Object.entries(row || {})) {
        const normalizedKey = String(key || "").trim().toLowerCase();
        if (normalizedKey === "number") out.Number = String(value ?? "").replace(/\D+/g, "");
        else if (normalizedKey === "activated") out.activated = String(value ?? "").trim().toLowerCase();
        else out[key] = value;
      }
      return out;
    }).filter((row) => row.Number);
  }

  function formatRate(numerator, denominator) {
    const den = Number(denominator || 0);
    if (!den) return "";
    return `${((Number(numerator || 0) / den) * 100).toFixed(2)}%`;
  }

  return {
    COUNTRY_MAP,
    PhoneCleaner,
    LeadCleaner
  };
});
