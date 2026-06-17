const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { parse } = require("csv-parse/sync");

const app = express();
app.use(cors());
app.use(express.static("public"));

const SHEET_ID = "1mDjPwVt5o44DY-63I3uScK58WUADvpe_GSCDFtld4rw";
const SALES_SHEET = "판매량";
const SALES_ANALYSIS_SHEET = "판매량2";
const STOCK_SHEET = "재고";

function num(v) {
  if (v === undefined || v === null || v === "") return 0;
  return Number(String(v).replace(/,/g, "").replace(/[^\d.-]/g, "")) || 0;
}

function clean(v) {
  return String(v || "").replace(/\s+/g, "").trim();
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function monthKey(year, month) {
  return `${year}/${String(month).padStart(2, "0")}`;
}

function addMonths(year, month, add) {
  const d = new Date(year, month - 1 + add, 1);
  return { year: d.getFullYear(), month: d.getMonth() + 1 };
}

function formatDate(date) {
  if (!date || !isFinite(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function formatDateTime(date) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function daysBetween(fromDate, toDate) {
  const a = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const b = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
  return Math.ceil((b - a) / (24 * 60 * 60 * 1000));
}

async function readSheet(sheetName) {
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  const res = await axios.get(url);
  return parse(res.data, { columns: true, skip_empty_lines: true, bom: true });
}

function findValue(row, names) {
  const keys = Object.keys(row);
  for (const name of names) {
    const key = keys.find(k => clean(k) === clean(name));
    if (key) return row[key];
  }
  return "";
}

function findName(row) {
  return String(findValue(row, [
    "품목명", "품목", "품목별", "상품명", "제품명", "화분크기", "화분 크기"
  ]) || "").trim();
}

function parseMonthHeader(header) {
  const raw = String(header || "").trim();

  let m = raw.match(/^(\d{4})\s*년\s*(\d{1,2})\s*월$/);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };

  m = raw.match(/^(\d{4})[./-](\d{1,2})$/);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };

  m = raw.match(/^(\d{2})[./-](\d{1,2})$/);
  if (m) return { year: 2000 + Number(m[1]), month: Number(m[2]) };

  return null;
}

function buildSalesAnalysis(rows) {
  const productMap = {};

  rows.forEach(row => {
    const productName = findName(row);
    if (!productName || productName.includes("총합계")) return;

    if (!productMap[productName]) {
      productMap[productName] = {};
    }

    Object.keys(row).forEach(header => {
      const parsed = parseMonthHeader(header);
      if (!parsed) return;

      const key = monthKey(parsed.year, parsed.month);
      productMap[productName][key] = (productMap[productName][key] || 0) + num(row[header]);
    });
  });

  const products = Object.keys(productMap).map(productName => {
    const monthlySales = Object.keys(productMap[productName])
      .map(key => {
        const [year, month] = key.split("/").map(Number);
        return {
          key,
          year,
          month,
          label: `${year}.${String(month).padStart(2, "0")}`,
          qty: productMap[productName][key]
        };
      })
      .filter(x => x.year > 2023 || (x.year === 2023 && x.month >= 3))
      .sort((a, b) => a.year === b.year ? a.month - b.month : a.year - b.year);

    const yearlyMap = {};
    monthlySales.forEach(item => {
      yearlyMap[item.year] = (yearlyMap[item.year] || 0) + item.qty;
    });

    const yearlySales = Object.keys(yearlyMap)
      .map(year => ({ year: Number(year), qty: yearlyMap[year] }))
      .sort((a, b) => a.year - b.year);

    const now = new Date();
    const thisYear = now.getFullYear();
    const thisMonth = now.getMonth() + 1;

    let thisYearTotal = 0;
    let lastYearTotal = 0;

    for (let m = 1; m <= thisMonth; m++) {
      thisYearTotal += productMap[productName][monthKey(thisYear, m)] || 0;
      lastYearTotal += productMap[productName][monthKey(thisYear - 1, m)] || 0;
    }

    let growthRate = 100;
    if (lastYearTotal > 0) growthRate = Math.round(clamp(thisYearTotal / lastYearTotal, 0.3, 4) * 100);
    else if (thisYearTotal > 0) growthRate = 130;

    const recent3 = monthlySales.slice(-3).reduce((sum, x) => sum + x.qty, 0);
    const prev3 = monthlySales.slice(-6, -3).reduce((sum, x) => sum + x.qty, 0);

    let recentMomentumRate = 100;
    if (prev3 > 0) recentMomentumRate = Math.round(clamp(recent3 / prev3, 0.3, 4) * 100);
    else if (recent3 > 0) recentMomentumRate = 120;

    const expectedGrowthRate = Math.round(growthRate * 0.65 + recentMomentumRate * 0.35);

    return {
      productName,
      monthlySales,
      yearlySales,
      growthRate,
      recentMomentumRate,
      expectedGrowthRate,
      totalSales: monthlySales.reduce((sum, x) => sum + x.qty, 0)
    };
  });

  const monthMap = {};
  products.forEach(product => {
    product.monthlySales.forEach(item => {
      monthMap[item.key] = (monthMap[item.key] || 0) + item.qty;
    });
  });

  const totalMonthlySales = Object.keys(monthMap)
    .map(key => {
      const [year, month] = key.split("/").map(Number);
      return {
        key,
        year,
        month,
        label: `${year}.${String(month).padStart(2, "0")}`,
        qty: monthMap[key]
      };
    })
    .sort((a, b) => a.year === b.year ? a.month - b.month : a.year - b.year);

  const yearMap = {};
  totalMonthlySales.forEach(item => {
    yearMap[item.year] = (yearMap[item.year] || 0) + item.qty;
  });

  const totalYearlySales = Object.keys(yearMap)
    .map(year => ({ year: Number(year), qty: yearMap[year] }))
    .sort((a, b) => a.year - b.year);

  return {
    products: products.sort((a, b) => b.totalSales - a.totalSales),
    totalMonthlySales,
    totalYearlySales
  };
}

function calcProductGrowthRate(row) {
  const today = new Date();
  const currentYear = today.getFullYear();
  const prevYear = currentYear - 1;
  const currentMonth = today.getMonth() + 1;

  let currentTotal = 0;
  let prevTotal = 0;

  for (let m = 1; m <= currentMonth; m++) {
    currentTotal += num(row[monthKey(currentYear, m)]);
    prevTotal += num(row[monthKey(prevYear, m)]);
  }

  if (prevTotal <= 0 && currentTotal > 0) return 1.3;
  if (prevTotal <= 0) return 1;

  return clamp(currentTotal / prevTotal, 0.5, 3);
}

function forecastBySeason(row, leadTimeDays, productGrowthRate) {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const leadMonths = Math.ceil(leadTimeDays / 30);

  let forecast = 0;
  const detail = [];

  for (let i = 0; i < leadMonths; i++) {
    const target = addMonths(year, month, i);
    const lastYearQty = num(row[monthKey(target.year - 1, target.month)]);
    const twoYearsAgoQty = num(row[monthKey(target.year - 2, target.month)]);
    const threeYearsAgoQty = num(row[monthKey(target.year - 3, target.month)]);

    let baseQty = lastYearQty;
    if (baseQty <= 0) {
      const oldValues = [twoYearsAgoQty, threeYearsAgoQty].filter(v => v > 0);
      baseQty = oldValues.length ? oldValues.reduce((a, b) => a + b, 0) / oldValues.length : 0;
    }

    const predicted = Math.round(baseQty * productGrowthRate);
    forecast += predicted;
    detail.push(`${target.month}월:${predicted.toLocaleString()}`);
  }

  return {
    forecast: Math.round(forecast),
    monthlyForecast: Math.round(forecast / leadMonths),
    detail: detail.join(" / ")
  };
}

app.get("/api/sales-analysis", async (req, res) => {
  try {
    const rows = await readSheet(SALES_ANALYSIS_SHEET);
    res.json({
      updatedAt: formatDateTime(new Date()),
      ...buildSalesAnalysis(rows)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "판매량2 시트 분석 실패",
      message: err.message
    });
  }
});

app.get("/api/inventory", async (req, res) => {
  try {
    const salesRows = await readSheet(SALES_SHEET);
    const stockRows = await readSheet(STOCK_SHEET);
    const updatedAt = new Date();

    const salesMap = {};
    salesRows.forEach(row => {
      const name = row["품목별"] || row["품목명"] || row["품목"];
      if (!name || name.includes("총합계")) return;
      salesMap[name.trim()] = row;
    });

    const today = new Date();

    const result = stockRows.map(row => {
      const productName = (row["품목명"] || row["품목별"] || row["품목"] || "").trim();
      if (!productName || productName.includes("총합계")) return null;

      const currentStock = num(row["현재고"]);
      const incomingStock = num(row["입고예정"]);
      const leadTime = num(row["리드타임"]) || 90;
      const manualOrder = row["발주제안"] || "";

      const availableStock = currentStock + incomingStock;
      const salesRow = salesMap[productName];

      let productGrowthRate = 1;
      let seasonalForecast = 0;
      let monthlyForecast = 0;
      let forecastDetail = "-";

      if (salesRow) {
        productGrowthRate = calcProductGrowthRate(salesRow);
        const forecastResult = forecastBySeason(salesRow, leadTime, productGrowthRate);
        seasonalForecast = forecastResult.forecast;
        monthlyForecast = forecastResult.monthlyForecast;
        forecastDetail = forecastResult.detail;
      } else {
        seasonalForecast = num(row["작년판매"]);
        monthlyForecast = Math.round(seasonalForecast / Math.ceil(leadTime / 30));
        forecastDetail = "판매량 시트 매칭 없음";
      }

      const safetyStock = monthlyForecast;
      const shortage = Math.ceil(seasonalForecast + safetyStock - availableStock);
      const avgDailyForecast = monthlyForecast / 30;
      const daysLeft = avgDailyForecast > 0 ? Math.round(availableStock / avgDailyForecast) : 9999;

      const stockoutDate = daysLeft === 9999 ? null : new Date(today);
      if (stockoutDate) stockoutDate.setDate(today.getDate() + daysLeft);

      const recommendedOrderDate = stockoutDate ? new Date(stockoutDate) : null;
      if (recommendedOrderDate) recommendedOrderDate.setDate(stockoutDate.getDate() - leadTime);

      const orderDelayDays = recommendedOrderDate
        ? Math.max(0, daysBetween(recommendedOrderDate, today))
        : 0;

      let stockoutGroup = "안전";
      if (daysLeft <= 30) stockoutGroup = "🔥 30일 내 품절";
      else if (daysLeft <= 60) stockoutGroup = "🔥 60일 내 품절";
      else if (daysLeft <= 90) stockoutGroup = "🔥 90일 내 품절";

      let status = "🟢 안전";
      let action = "발주 보류";

      if (shortage > 0) {
        status = "🔴 즉시발주";
        action = `최소 ${Math.max(0, shortage).toLocaleString()}개 부족 예상`;
        if (orderDelayDays > 0) action += ` / 발주 ${orderDelayDays}일 지연`;
      } else if (daysLeft <= leadTime + 30) {
        status = "🟡 주의";
        action = "30일 내 발주 검토";
      }

      if (manualOrder) action += ` / 기존 제안: ${manualOrder}`;

      return {
        productName,
        currentStock,
        incomingStock,
        availableStock,
        leadTime,
        growthRate: Math.round(productGrowthRate * 100),
        monthlyForecast,
        seasonalForecast,
        forecastDetail,
        safetyStock,
        shortage: Math.max(0, shortage),
        daysLeft,
        stockoutDate: formatDate(stockoutDate),
        recommendedOrderDate: formatDate(recommendedOrderDate),
        orderDelayDays,
        stockoutGroup,
        status,
        action,
        updatedAt: formatDateTime(updatedAt),
        priorityScore:
          Math.max(0, shortage) * 1000 +
          Math.max(0, 365 - Math.min(daysLeft, 365)) +
          orderDelayDays * 100
      };
    }).filter(Boolean);

    result.sort((a, b) => {
      const order = { "🔴 즉시발주": 1, "🟡 주의": 2, "🟢 안전": 3 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      return a.daysLeft - b.daysLeft;
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "구글시트 연동 실패",
      message: err.message
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("발주 대시보드 실행 중");
});
