# 全球电话号码清理器 / Global Phone Number Cleaner

一款无需服务器的前端手机号清洗工具，支持多国号码格式校验、类型识别与批量导出。

🔗 **在线访问**：[https://lyan0328chris-png.github.io/global_phonenumber_cleaner/](https://lyan0328chris-png.github.io/global_phonenumber_cleaner/)
> 访问需要密码，请联系管理员获取。

---

## 功能特性

- **多国支持**：中国、美国、巴西、墨西哥、马来西亚、越南、印尼、南非、尼日利亚、加纳、肯尼亚
- **自动识别手机号列**：按列名关键词 + 样本值特征自动匹配
- **号码预处理**：
  - 去除分机号后缀（ext / x / #）
  - 处理 Excel 浮点数残留（如 `861381234.0`）
  - 规范化 `+CC (0)XX` 格式（去除本地 trunk 0）
  - 按国家配置处理 trunk 前缀（如 `+2540203...` → `+254203...`，巴西识别 `0+运营商码+区号+号码`）
  - 空格分隔的多号码自动拆分（如 `+254 7XX XXX +254 7YY YYY`）
- **号码验证**：基于 Google `libphonenumber`，`isValid()` 严格校验，`isPossible()` 兜底
- **多候选取优**：单元格含多号码时，优先选 Mobile > Fixed Line > 其他有效
- **默认国家码**：可手动指定，优先级高于自动检测，防止区号被误判为他国国家码
- **输出格式**：E.164 / 国际格式 / 本地格式
- **号码类型过滤**：全部 / 仅手机 / 仅固话 / 手机+固话
- **严格分类模式**：可将导出的 `phone_type` 从库原始类型改为业务枚举，如 `valid_mobile`、`valid_fixed_line`、`valid_ambiguous`、`valid_voip`、`invalid`
- **去重**：按清洗后号码自动去重，保留首次出现记录
- **批量导出**：导出完整 CSV（含所有原始字段）或仅导出号码列
- **处理统计**：有效数、无效数、成功率、类型分布、失败原因 Top 5
- **固定落盘**：选择输出目录后，自动写入 `Cleanedforcheck/国家名_ISO_区号/`
- **WhatsApp 校验**：可生成 TH333 待校验 txt，并将结果回填到 leads 的 `is_wa` 字段

---

## Trunk 前缀规则

选择默认国家后，脚本会按国家配置处理本地拨号前缀，而不是所有国家一刀切删除开头 `0`：

| 国家码 | 规则 |
|--------|------|
| `52` 墨西哥 | 不删除前导 `0`；非国际格式且以 `0` 开头会判为 `bad format` |
| `1` 美国 | 不删除前导 `0`，避免误改 NANP 号码 |
| `55` 巴西 | 识别并移除 `0 + 2位运营商码 + 10/11位区号号码`，也兼容 `0 + 10/11位区号号码` |
| `86`、`60`、`234`、`84`、`27`、`62`、`233`、`254` | 删除单个本地 trunk `0` 后再拼国家码 |
| 未指定国家 | 不按 trunk 规则删除前导 `0`，避免在未知国家下误改号码 |

---

## 支持文件格式

| 格式 | 说明 |
|------|------|
| `.xlsx` | 推荐，支持 30MB 以内文件，超宽表（>50列）自动稀疏读取 |
| `.csv` | 支持 UTF-8、GB18030、UTF-16LE/BE、Windows-1252、Big5 编码自动检测 |

> **注意**：xlsx 超过 100MB 会硬拦截，建议先另存为 CSV 或使用 `split_excel.py` 拆分。

---

## 自动化输出

网页端使用 Chrome / Edge 时，可以选择输出目录。清洗后会自动生成：

| 文件 | 说明 |
|------|------|
| `源名_cleaned.csv` | 完整 leads 清洗结果 |
| `源名_wa待校验.txt` | 提交 TH333 的号码文件，每行一个号码，不带 `+` |
| `源名_wa已校验.csv` | WhatsApp 结果回填后的完整 leads，新增 `is_wa` 字段 |
| `源名_wa已校验_号码结果.csv` | 号码级 WhatsApp 校验结果 |
| `Cleanedforcheck/数据统计汇总.csv` | 所有清洗批次共用的统计汇总，每次追加一行 |

统计汇总文件表头固定为：

`来源名称`、`leads 获取总数`、`手机号数（非空值）`、`漏斗1 手机号非空留存率`、`有效手机号（清洗后为有效手机号或 landline）`、`漏斗2 清洗有效留存率`、`上传+52号码总数`、`漏斗3 WA待检留存率`、`WA验证通过数`、`WA 筛出率`、`数据质量说明`

其中 `有效手机号（清洗后为有效手机号或 landline）` 统计所有检测国家中清洗有效且类型为 `MOBILE`、`FIXED_LINE` 或 `FIXED_LINE_OR_MOBILE` 的号码，不限定 `+52`。

`数据质量说明` 会自动描述最大漏损环节和原因，例如有效号码主要是非目标国家、原始号码脱敏/加密、手机号字段缺失、号码格式或号段无法通过校验等。

漏斗口径：

| 漏斗 | 留存率 |
|------|--------|
| 漏斗1 | `手机号数（非空值） / leads 获取总数` |
| 漏斗2 | `有效手机号 / 手机号数（非空值）` |
| 漏斗3 | `上传+52号码总数 / 有效手机号` |
| WA 筛出率 | `WA验证通过数 / 上传+52号码总数` |

`is_wa` 取值规则：

| TH333 `activated` | `is_wa` |
|-------------------|---------|
| `yes` | `1` |
| `no` | `0` |
| 未提交或未匹配 | 空 |

---

## 本地辅助脚本

### `scripts/clean-leads.js`
备用批量入口，适合处理文件夹或浏览器无法直接调用 TH333 API 的情况。

首次使用先安装依赖：

```bash
npm install
```

交互式运行：

```bash
npm run clean
```

带参数运行：

```bash
npm run clean -- --input /path/to/leads.xlsx --country 52 --output /path/to/output --wa
```

参数说明：

| 参数 | 说明 |
|------|------|
| `--input` / `-i` | leads 文件或文件夹路径，支持 `.xlsx` / `.csv` |
| `--country` / `-c` | 国家区号，如 `52`、`60`、`234` |
| `--output` / `-o` | 输出根目录，脚本会创建 `Cleanedforcheck` |
| `--wa` | 清洗后提交 TH333 `wsValid` 校验 |
| `--token` | TH333 token；不传则运行时输入 |
| `--strict-classification` | 启用严格分类，`phone_type` 输出 `valid_*` / `invalid` 枚举，且仅接受 `isValid()` 号码 |

严格分类下 `phone_type` 常见取值：

| 取值 | 说明 |
|------|------|
| `valid_mobile` | 严格识别为手机号 |
| `valid_fixed_line` | 严格识别为座机 |
| `valid_ambiguous` | 号码有效，但 libphonenumber 返回的类型是 `FIXED_LINE_OR_MOBILE`，即仅凭号码规则无法严格判断它是手机号还是座机号；通常仅美国、墨西哥会出现 |
| `valid_voip` | 网络电话 |
| `valid_toll_free` | 免费电话 |
| `valid_premium_rate` | 高费率电话 |
| `valid_shared_cost` | 分摊计费电话 |
| `valid_personal_number` | 个人号码 |
| `valid_pager` | 寻呼机号码 |
| `valid_uan` | 统一接入号码 |
| `valid_voicemail` | 语音信箱 |
| `valid_unknown` | 有效但库未返回具体类型 |
| `invalid` | 无效、空号、库未加载或号段不符 |

`valid_ambiguous` 不包含 VoIP、免费电话、高费率电话、寻呼机、语音信箱等其它格式；这些类型会分别归入对应的 `valid_*` 枚举。

### `split_excel.py`
将超大 xlsx 文件按行数拆分为多个 CSV，便于分批上传处理。

```bash
python3 split_excel.py
```

---

## 技术栈

- **SheetJS (xlsx@0.18.5)**：Excel / CSV 解析
- **libphonenumber-js@1.11.13**（max bundle）：号码验证与格式化，数据来源 Google libphonenumber
- **共享清洗核心**：`src/phone-cleaner-core.js` 是网页和本地脚本共同使用的唯一清洗规则来源
- 纯 HTML + Vanilla JS，无框架依赖；未勾选 WhatsApp 校验时，数据仅在浏览器本地处理

---

## 更新部署

1. 清洗规则统一修改 `src/phone-cleaner-core.js`
2. 网页界面修改 `index.html`
3. 同步到中文文件名：
   ```bash
   cp index.html 多国手机号清洗工具_index.html
   ```
4. 上传 `index.html` 和 `src/phone-cleaner-core.js` 到 GitHub 仓库，Pages 约 1 分钟后自动更新
