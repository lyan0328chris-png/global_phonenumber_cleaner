# 全局电话号码清理器 / Global Phone Number Cleaner

一款纯前端、无需服务器的手机号清洗工具，支持多国号码格式校验、类型识别与批量导出。

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
  - 处理国际格式中多余的 trunk 0（如 `+2540203...` → `+254203...`）
  - 空格分隔的多号码自动拆分（如 `+254 7XX XXX +254 7YY YYY`）
- **号码验证**：基于 Google `libphonenumber`，`isValid()` 严格校验，`isPossible()` 兜底
- **多候选取优**：单元格含多号码时，优先选 Mobile > Fixed Line > 其他有效
- **默认国家码**：可手动指定，优先级高于自动检测，防止区号被误判为他国国家码
- **输出格式**：E.164 / 国际格式 / 本地格式
- **号码类型过滤**：全部 / 仅手机 / 仅固话 / 手机+固话
- **去重**：按清洗后号码自动去重，保留首次出现记录
- **批量导出**：导出完整 CSV（含所有原始字段）或仅导出号码列
- **处理统计**：有效数、无效数、成功率、类型分布、失败原因 Top 5

---

## 支持文件格式

| 格式 | 说明 |
|------|------|
| `.xlsx` | 推荐，支持 30MB 以内文件，超宽表（>50列）自动稀疏读取 |
| `.csv` | 支持 UTF-8、GB18030、UTF-16LE/BE、Windows-1252、Big5 编码自动检测 |

> **注意**：xlsx 超过 100MB 会硬拦截，建议先另存为 CSV 或使用 `split_excel.py` 拆分。

---

## 本地辅助脚本

### `split_excel.py`
将超大 xlsx 文件按行数拆分为多个 CSV，便于分批上传处理。

```bash
python3 split_excel.py
```

---

## 技术栈

- **SheetJS (xlsx@0.18.5)**：Excel / CSV 解析
- **libphonenumber-js@1.11.13**（max bundle）：号码验证与格式化，数据来源 Google libphonenumber
- 纯 HTML + Vanilla JS，无框架依赖，所有处理在浏览器本地完成，**数据不上传服务器**

---

## 更新部署

1. 修改 `多国手机号清洗工具_index.html`
2. 同步到 `index.html`：
   ```bash
   cp 多国手机号清洗工具_index.html index.html
   ```
3. 上传 `index.html` 到 GitHub 仓库覆盖，Pages 约 1 分钟后自动更新
