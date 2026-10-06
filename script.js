const rwaInput = document.getElementById("rwaInput");
const poolName = document.getElementById("poolName");
const assetType = document.getElementById("assetType");
const fileInput = document.getElementById("fileInput");
const runReview = document.getElementById("runReview");
const loadStable = document.getElementById("loadStable");
const loadStress = document.getElementById("loadStress");
const copyReport = document.getElementById("copyReport");
const parseStatus = document.getElementById("parseStatus");
const agentStatus = document.getElementById("agentStatus");
const riskBadge = document.getElementById("riskBadge");
const riskScore = document.getElementById("riskScore");
const meterArc = document.getElementById("meterArc");
const meterNeedle = document.getElementById("meterNeedle");
const metricGrid = document.getElementById("metricGrid");
const decisionFlow = document.getElementById("decisionFlow");
const report = document.getElementById("report");
const anomalyList = document.getElementById("anomalyList");
const anomalyCount = document.getElementById("anomalyCount");

const requiredColumns = [
  "日期",
  "抵押估值",
  "借款餘額",
  "清算門檻",
  "Oracle價格",
  "評估價格",
  "流動性深度",
  "30日違約率",
  "巨鯨提領",
  "審計分數",
  "智能合約風險"
];

const samples = {
  stable: `日期,抵押估值,借款餘額,清算門檻,Oracle價格,評估價格,流動性深度,30日違約率,巨鯨提領,審計分數,智能合約風險
2026-09-22,12800000,6120000,0.78,1.002,1.000,4900000,0.018,260000,91,0.18
2026-09-29,13150000,6280000,0.78,1.001,1.000,5200000,0.019,310000,92,0.17
2026-10-06,13380000,6410000,0.78,0.998,1.000,5350000,0.020,280000,92,0.16`,
  stress: `日期,抵押估值,借款餘額,清算門檻,Oracle價格,評估價格,流動性深度,30日違約率,巨鯨提領,審計分數,智能合約風險
2026-09-22,14600000,7600000,0.80,1.004,1.000,6100000,0.024,420000,86,0.24
2026-09-29,13900000,8120000,0.80,0.991,1.000,4300000,0.038,1120000,78,0.31
2026-10-06,10800000,8460000,0.80,0.902,0.980,1850000,0.071,2860000,64,0.58`
};

rwaInput.value = samples.stress;
runAnalysis();

loadStable.addEventListener("click", () => {
  rwaInput.value = samples.stable;
  poolName.value = "Tokenized T-Bill Senior Vault";
  assetType.value = "國債代幣";
  runAnalysis();
});

loadStress.addEventListener("click", () => {
  rwaInput.value = samples.stress;
  poolName.value = "Asia Invoice RWA Vault";
  assetType.value = "應收帳款代幣";
  runAnalysis();
});

runReview.addEventListener("click", runAnalysis);
rwaInput.addEventListener("input", debounce(runAnalysis, 350));

fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  const text = await file.text();
  rwaInput.value = text.trim();
  runAnalysis();
});

copyReport.addEventListener("click", async () => {
  const text = report.innerText.trim();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  copyReport.textContent = "已複製";
  setTimeout(() => {
    copyReport.textContent = "複製報告";
  }, 1200);
});

function runAnalysis() {
  animateSteps();
  const parsed = parseRwaData(rwaInput.value);

  if (!parsed.ok) {
    parseStatus.textContent = "資料格式待修正";
    agentStatus.textContent = "無法產出";
    renderEmpty(parsed.error);
    return;
  }

  const rows = parsed.rows.sort((a, b) => new Date(a["日期"]) - new Date(b["日期"]));
  const enriched = rows.map((row, index) => enrichRow(row, rows[index - 1]));
  const latest = enriched[enriched.length - 1];
  const previous = enriched[enriched.length - 2];
  const anomalies = detectAnomalies(latest, previous, enriched);
  const score = scoreRisk(latest, anomalies);
  const level = classifyRisk(score, latest);
  const memo = buildMemo(enriched, latest, previous, anomalies, score, level);

  parseStatus.textContent = `已解析 ${rows.length} 期`;
  agentStatus.textContent = "掃描完成";
  renderMeter(score, level);
  renderMetrics(latest, previous);
  renderDecisionFlow(latest, anomalies, level);
  renderAnomalies(anomalies, latest);
  renderReport(memo);
}

function parseRwaData(text) {
  const source = text.trim();
  if (!source) return { ok: false, error: "尚未輸入 RWA 風險資料。" };

  try {
    if (source.startsWith("[") || source.startsWith("{")) {
      const json = JSON.parse(source);
      const rows = Array.isArray(json) ? json : json.rows;
      return normalizeRows(rows);
    }
  } catch (error) {
    return { ok: false, error: "JSON 格式無法解析，請檢查括號、逗號與欄位名稱。" };
  }

  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return { ok: false, error: "至少需要表頭與兩期風險資料。" };

  const headers = splitLine(lines[0]);
  const rows = lines.slice(1).map((line) => {
    const cells = splitLine(line);
    return Object.fromEntries(headers.map((header, index) => [header, cells[index]]));
  });
  return normalizeRows(rows);
}

function normalizeRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) {
    return { ok: false, error: "至少需要兩期資料，才能判斷價格、違約率與流動性的變化。" };
  }

  const missing = requiredColumns.filter((column) => !Object.prototype.hasOwnProperty.call(rows[0], column));
  if (missing.length) {
    return { ok: false, error: `缺少欄位：${missing.join("、")}。` };
  }

  const normalized = rows.map((row) => {
    const next = {};
    requiredColumns.forEach((column) => {
      next[column] = column === "日期" ? String(row[column]).trim() : toNumber(row[column]);
    });
    return next;
  });

  const invalid = normalized.some((row) => requiredColumns.some((column) => {
    if (column === "日期") return !row[column] || Number.isNaN(new Date(row[column]).getTime());
    return row[column] === "" || Number.isNaN(row[column]);
  }));
  if (invalid) return { ok: false, error: "資料中有空值、日期錯誤或非數字欄位；PoC 不會自行補值以避免產生錯誤風險結論。" };

  return { ok: true, rows: normalized };
}

function splitLine(line) {
  return line.split(/\t|,/).map((cell) => cell.trim());
}

function enrichRow(row, previous) {
  const ltv = row["借款餘額"] / row["抵押估值"];
  const healthFactor = (row["抵押估值"] * row["清算門檻"]) / row["借款餘額"];
  const assetCoverage = row["抵押估值"] / row["借款餘額"];
  const liquidityCoverage = row["流動性深度"] / row["借款餘額"];
  const oracleDepeg = (row["Oracle價格"] - row["評估價格"]) / row["評估價格"];
  const collateralChange = previous ? changeRate(row["抵押估值"], previous["抵押估值"]) : 0;
  const liquidityChange = previous ? changeRate(row["流動性深度"], previous["流動性深度"]) : 0;
  const defaultRateChange = previous ? row["30日違約率"] - previous["30日違約率"] : 0;
  const withdrawalToLiquidity = row["巨鯨提領"] / Math.max(row["流動性深度"], 1);

  return {
    ...row,
    ltv,
    healthFactor,
    assetCoverage,
    liquidityCoverage,
    oracleDepeg,
    collateralChange,
    liquidityChange,
    defaultRateChange,
    withdrawalToLiquidity
  };
}

function detectAnomalies(latest, previous, rows) {
  const defaultRates = rows.map((row) => row["30日違約率"]);
  const defaultZ = zScore(latest["30日違約率"], defaultRates);
  const checks = [
    {
      hit: latest.healthFactor < 1.05,
      severity: "critical",
      title: "健康因子逼近清算線",
      detail: `Health Factor 為 ${ratio(latest.healthFactor)}，已低於 1.05 的緊急預警門檻。`,
      evidence: `(抵押估值 ${money(latest["抵押估值"])} x 清算門檻 ${pct(latest["清算門檻"])}) / 借款餘額 ${money(latest["借款餘額"])}`
    },
    {
      hit: latest.ltv > latest["清算門檻"] * 0.92,
      severity: "high",
      title: "LTV 接近清算門檻",
      detail: `LTV 為 ${pct(latest.ltv)}，距清算門檻 ${pct(latest["清算門檻"])} 的緩衝不足。`,
      evidence: `借款餘額 ${money(latest["借款餘額"])} / 抵押估值 ${money(latest["抵押估值"])}`
    },
    {
      hit: latest.oracleDepeg <= -0.04 || latest.oracleDepeg >= 0.04,
      severity: "high",
      title: "Oracle 價格脫鉤",
      detail: `Oracle 與評估價格偏離 ${pct(latest.oracleDepeg)}，需檢查餵價延遲或流動性失真。`,
      evidence: `Oracle ${latest["Oracle價格"]} vs 評估 ${latest["評估價格"]}`
    },
    {
      hit: latest.collateralChange <= -0.15,
      severity: "high",
      title: "抵押估值快速下跌",
      detail: `抵押估值較前期下跌 ${pct(Math.abs(latest.collateralChange))}，可能觸發價格閃崩風險。`,
      evidence: `${money(previous["抵押估值"])} -> ${money(latest["抵押估值"])}`
    },
    {
      hit: latest.liquidityCoverage < 0.35 || latest.liquidityChange <= -0.35,
      severity: "high",
      title: "鏈上流動性深度不足",
      detail: `流動性覆蓋率為 ${pct(latest.liquidityCoverage)}，大額清算可能造成滑價。`,
      evidence: `流動性深度 ${money(latest["流動性深度"])} / 借款餘額 ${money(latest["借款餘額"])}`
    },
    {
      hit: latest["30日違約率"] >= 0.05 || defaultZ >= 1.5,
      severity: "high",
      title: "鏈下資產違約率異常",
      detail: `30 日預期違約率升至 ${pct(latest["30日違約率"])}，Z-Score 約 ${ratio(defaultZ)}。`,
      evidence: `前期 ${pct(previous["30日違約率"])} -> 最新 ${pct(latest["30日違約率"])}`
    },
    {
      hit: latest.withdrawalToLiquidity >= 0.6,
      severity: "medium",
      title: "巨鯨大額提領",
      detail: `巨鯨提領相當於流動性深度 ${pct(latest.withdrawalToLiquidity)}，可能造成擠兌或信心衝擊。`,
      evidence: `提領 ${money(latest["巨鯨提領"])} / 流動性 ${money(latest["流動性深度"])}`
    },
    {
      hit: latest["審計分數"] < 70 || latest["智能合約風險"] >= 0.5,
      severity: "medium",
      title: "審計或智能合約風險升高",
      detail: `審計分數 ${latest["審計分數"]}，合約風險 ${pct(latest["智能合約風險"])}，需啟動技術覆核。`,
      evidence: `Audit ${latest["審計分數"]}/100；Contract Risk ${pct(latest["智能合約風險"])}`
    }
  ];

  return checks.filter((check) => check.hit);
}

function scoreRisk(latest, anomalies) {
  let score = 12;
  score += latest.healthFactor < 1 ? 28 : latest.healthFactor < 1.05 ? 22 : latest.healthFactor < 1.2 ? 12 : 2;
  score += latest.ltv > 0.75 ? 16 : latest.ltv > 0.65 ? 9 : 2;
  score += Math.abs(latest.oracleDepeg) > 0.06 ? 14 : Math.abs(latest.oracleDepeg) > 0.03 ? 8 : 0;
  score += latest.liquidityCoverage < 0.3 ? 14 : latest.liquidityCoverage < 0.5 ? 8 : 0;
  score += latest["30日違約率"] > 0.06 ? 12 : latest["30日違約率"] > 0.04 ? 7 : 0;
  score += latest["智能合約風險"] > 0.5 ? 8 : latest["智能合約風險"] > 0.3 ? 4 : 0;
  score += anomalies.filter((item) => item.severity === "critical").length * 8;
  score += anomalies.filter((item) => item.severity === "high").length * 5;
  score += anomalies.filter((item) => item.severity === "medium").length * 2;
  return clamp(Math.round(score), 0, 100);
}

function classifyRisk(score, latest) {
  if (latest.healthFactor < 1 || score >= 82) return { label: "清算警戒", className: "critical", action: "建議暫停新增借款、啟動多簽覆核並準備分批清算方案" };
  if (score >= 65) return { label: "高度風險", className: "high", action: "建議調降借款上限、提高保證金並加密 Oracle 監控" };
  if (score >= 40) return { label: "中度風險", className: "medium", action: "建議維持額度但提高監控頻率與文件覆核深度" };
  return { label: "低度風險", className: "low", action: "可進入例行監控流程" };
}

function buildMemo(rows, latest, previous, anomalies, score, level) {
  const hardRules = [
    `LTV ${pct(latest.ltv)}`,
    `Health Factor ${ratio(latest.healthFactor)}`,
    `Asset Coverage ${ratio(latest.assetCoverage)}`,
    `Oracle De-peg ${pct(latest.oracleDepeg)}`,
    `Liquidity Coverage ${pct(latest.liquidityCoverage)}`
  ].join("；");

  const anomalyText = anomalies.length
    ? anomalies.map((item) => `${item.title}（${item.evidence}）`).join("；")
    : "未觸發重大鏈上或鏈下異常規則";

  const recommendation = score >= 82 || latest.healthFactor < 1
    ? "建議立即凍結新增借款，通知治理多簽與風控委員會，依流動性深度採分批清算或追加抵押，避免一次性清算造成折價。"
    : score >= 65
      ? "建議暫停調升借款額度，要求發行方補充最新資產明細、違約池資料與第三方估值，並調高 Oracle 更新頻率。"
      : score >= 40
        ? "可維持既有額度，但需進入週頻監控，追蹤違約率、巨鯨資金流與 Oracle 偏離。"
        : "可維持例行監控，保留月度 RWA 文件覆審與鏈上指標核對。";

  return {
    title: `${poolName.value || "RWA 借貸池"} ${latest["日期"]} 風險覆審摘要`,
    overview: `本次 Agent 解析 ${rows.length} 期 RWA 風險快照，最新風險分數為 ${score}/100，判定為${level.label}。${level.action}。`,
    collateral: `抵押資產類型為${assetType.value}；抵押估值 ${money(latest["抵押估值"])}，較前期${latest.collateralChange >= 0 ? "上升" : "下跌"} ${pct(Math.abs(latest.collateralChange))}。`,
    onchain: `硬性鏈上規則：${hardRules}。`,
    offchain: `鏈下訊號：30 日預期違約率 ${pct(latest["30日違約率"])}，審計分數 ${latest["審計分數"]}/100，智能合約風險 ${pct(latest["智能合約風險"])}。`,
    risk: anomalyText,
    recommendation,
    guardrail: "本報告把可計算數值與 AI 語意判讀分開呈現；缺漏資料一律標示待補件，不由模型自行推測。清算、額度調整與治理操作仍需人工覆核。"
  };
}

function renderMeter(score, level) {
  riskScore.textContent = score;
  riskBadge.textContent = level.label;
  riskBadge.className = `risk-badge ${level.className}`;

  const dash = 270;
  meterArc.style.strokeDasharray = dash;
  meterArc.style.strokeDashoffset = dash * (1 - score / 100);
  meterArc.className.baseVal = `meter-arc ${level.className}`;

  const angle = -90 + score * 1.8;
  meterNeedle.setAttribute("transform", `rotate(${angle} 110 110)`);
}

function renderMetrics(latest, previous) {
  const metrics = [
    { label: "LTV", value: pct(latest.ltv), trend: `門檻 ${pct(latest["清算門檻"])}`, state: latest.ltv <= latest["清算門檻"] * 0.75 ? "good" : latest.ltv <= latest["清算門檻"] * 0.92 ? "watch" : "bad" },
    { label: "Health Factor", value: ratio(latest.healthFactor), trend: changeLabel(latest.healthFactor, previous.healthFactor), state: latest.healthFactor >= 1.25 ? "good" : latest.healthFactor >= 1.05 ? "watch" : "bad" },
    { label: "Asset Coverage", value: ratio(latest.assetCoverage), trend: changeLabel(latest.assetCoverage, previous.assetCoverage), state: latest.assetCoverage >= 1.45 ? "good" : latest.assetCoverage >= 1.2 ? "watch" : "bad" },
    { label: "Oracle De-peg", value: pct(latest.oracleDepeg), trend: `Oracle ${latest["Oracle價格"]}`, state: Math.abs(latest.oracleDepeg) <= 0.02 ? "good" : Math.abs(latest.oracleDepeg) <= 0.04 ? "watch" : "bad" },
    { label: "流動性覆蓋", value: pct(latest.liquidityCoverage), trend: `深度 ${money(latest["流動性深度"])}`, state: latest.liquidityCoverage >= 0.6 ? "good" : latest.liquidityCoverage >= 0.35 ? "watch" : "bad" },
    { label: "30日違約率", value: pct(latest["30日違約率"]), trend: `${latest.defaultRateChange >= 0 ? "+" : ""}${pct(latest.defaultRateChange)} vs 前期`, state: latest["30日違約率"] <= 0.025 ? "good" : latest["30日違約率"] <= 0.05 ? "watch" : "bad" }
  ];

  metricGrid.innerHTML = metrics.map((metric) => `
    <article class="metric-card ${metric.state}">
      <span>${metric.label}</span>
      <strong>${metric.value}</strong>
      <small>${metric.trend}</small>
    </article>
  `).join("");
}

function renderDecisionFlow(latest, anomalies, level) {
  const steps = [
    { title: "資料擷取", text: `讀取 ${poolName.value || "RWA Vault"} 的鏈上與鏈下快照。`, state: "done" },
    { title: "硬性規則", text: `HF ${ratio(latest.healthFactor)}、LTV ${pct(latest.ltv)}、De-peg ${pct(latest.oracleDepeg)}。`, state: latest.healthFactor < 1.05 || Math.abs(latest.oracleDepeg) > 0.04 ? "bad" : "done" },
    { title: "異常判定", text: `${anomalies.length} 項預警被觸發，依嚴重度排序進入報告。`, state: anomalies.length ? "bad" : "done" },
    { title: "覆核輸出", text: `${level.action}。`, state: level.className }
  ];

  decisionFlow.innerHTML = steps.map((step) => `
    <article class="flow-step ${step.state}">
      <span></span>
      <div>
        <strong>${step.title}</strong>
        <p>${step.text}</p>
      </div>
    </article>
  `).join("");
}

function renderAnomalies(anomalies, latest) {
  anomalyCount.textContent = `${anomalies.length} 項異常`;
  if (!anomalies.length) {
    anomalyList.innerHTML = `
      <article class="anomaly ok">
        <strong>未偵測重大異常</strong>
        <p>${latest["日期"]} 的 LTV、Health Factor、Oracle 偏離、違約率與流動性深度均未觸發預設警戒規則。</p>
        <span>Evidence: all hard-rule checks passed</span>
      </article>
    `;
    return;
  }

  anomalyList.innerHTML = anomalies.map((item) => `
    <article class="anomaly ${item.severity}">
      <strong>${item.title}</strong>
      <p>${item.detail}</p>
      <span>Evidence: ${item.evidence}</span>
    </article>
  `).join("");
}

function renderReport(memo) {
  report.innerHTML = `
    <h3>${memo.title}</h3>
    <dl>
      <div>
        <dt>一、覆審結論</dt>
        <dd>${memo.overview}</dd>
      </div>
      <div>
        <dt>二、抵押品與估值</dt>
        <dd>${memo.collateral}</dd>
      </div>
      <div>
        <dt>三、鏈上硬性規則</dt>
        <dd>${memo.onchain}</dd>
      </div>
      <div>
        <dt>四、鏈下與合約風險</dt>
        <dd>${memo.offchain}</dd>
      </div>
      <div>
        <dt>五、主要預警訊號</dt>
        <dd>${memo.risk}</dd>
      </div>
      <div>
        <dt>六、清算與授信建議</dt>
        <dd>${memo.recommendation}</dd>
      </div>
      <div>
        <dt>七、防幻覺控管</dt>
        <dd>${memo.guardrail}</dd>
      </div>
    </dl>
  `;
}

function renderEmpty(message) {
  metricGrid.innerHTML = "";
  decisionFlow.innerHTML = `<article class="flow-step bad"><span></span><div><strong>資料驗證失敗</strong><p>${message}</p></div></article>`;
  anomalyList.innerHTML = `<article class="anomaly high"><strong>資料無法解析</strong><p>${message}</p><span>Evidence: input validation failed</span></article>`;
  anomalyCount.textContent = "需修正";
  report.innerHTML = `<h3>尚未生成 RWA 風險報告</h3><p>${message}</p>`;
  renderMeter(0, { label: "待判定", className: "medium" });
}

function animateSteps() {
  document.querySelectorAll(".agent-steps li").forEach((step) => {
    step.classList.remove("active", "done");
  });

  const steps = Array.from(document.querySelectorAll(".agent-steps li"));
  steps.forEach((step, index) => {
    setTimeout(() => {
      step.classList.add("active");
      if (index > 0) steps[index - 1].classList.remove("active");
      if (index > 0) steps[index - 1].classList.add("done");
      if (index === steps.length - 1) {
        setTimeout(() => {
          step.classList.remove("active");
          step.classList.add("done");
        }, 180);
      }
    }, index * 110);
  });
}

function zScore(value, values) {
  const mean = values.reduce((sum, item) => sum + item, 0) / values.length;
  const variance = values.reduce((sum, item) => sum + Math.pow(item - mean, 2), 0) / values.length;
  const sd = Math.sqrt(variance);
  return sd === 0 ? 0 : (value - mean) / sd;
}

function changeRate(current, previous) {
  if (!previous) return 0;
  return (current - previous) / Math.abs(previous);
}

function changeLabel(current, previous) {
  const diff = current - previous;
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${diff.toFixed(2)} vs 前期`;
}

function toNumber(value) {
  if (typeof value === "number") return value;
  return Number(String(value).replace(/[$,%\s]/g, ""));
}

function money(value) {
  const sign = value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toLocaleString("zh-TW", { maximumFractionDigits: 0 })}`;
}

function pct(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function ratio(value) {
  if (!Number.isFinite(value)) return "N/A";
  return value.toFixed(2);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function debounce(callback, delay) {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => callback(...args), delay);
  };
}
