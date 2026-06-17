const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { parse } = require("csv-parse/sync");

const app = express();
app.use(cors());
app.use(express.static("public"));

const SHEET_ID = "1mDjPwVt5o44DY-63I3uScK58WUADvpe_GSCDFtld4rw";
const SALES_SHEET = "판매량";
const STOCK_SHEET = "재고";

function num(v) {
  if (v === undefined || v === null || v === "") return 0;
  return Number(String(v).replace(/,/g, "").replace(/[^\d.-]/g, "")) || 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function daysBetween(fromDate, toDate) {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.ceil((startOfDay(toDate) - startOfDay(fromDate)) / msPerDay);
}

function monthKey(year, month) {
  return `${year}/${String(month).padStart(2, "0")}`;
}

function addMonths(year, month, add) {
  const d = new Date(year, month - 1 + add, 1);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1
  };
}

async function readSheet(sheetName) {
  const url =
    `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;

  const res = await axios.get(url);
  return parse(res.data, {
    columns: true,
    skip_empty_lines: true,
    bom: true
  });
}

function extractMonthlySales(row) {
  const values = [];

  Object.keys(row).forEach(key => {
    const match = String(key).match(/^(\d{4})\/(\d{2})$/);
    if (!match) return;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const qty = num(row[key]);

    values.push({
      key,
      year,
      month,
      label: `${String(year).slice(2)}.${String(month).padStart(2, "0")}`,
      qty
    });
  });

  return values.sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return a.month - b.month;
  });
}

function buildYearlySales(monthlySales) {
  const map = {};

  monthlySales.forEach(item => {
    map[item.year] = (map[item.year] || 0) + item.qty;
  });

  return Object.keys(map)
    .map(year => ({
      year: Number(year),
      qty: map[year]
    }))
    .sort((a, b) => a.year - b.year);
}

function sumRecentMonths(monthlySales, year, endMonth, count) {
  let total = 0;

  for (let i = count - 1; i >= 0; i--) {
    const target = addMonths(year, endMonth, -i);
    const found = monthlySales.find(
      x => x.year === target.year && x.month === target.month
    );
    total += found ? found.qty : 0;
  }

  return total;
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

function calcExpectedGrowthRate(row) {
  const today = new Date();
  const currentYear = today.getFullYear();
  const currentMonth = today.getMonth() + 1;
  const monthlySales = extractMonthlySales(row);

  const ytdGrowth = calcProductGrowthRate(row);

  const recent3 = sumRecentMonths(monthlySales, currentYear, currentMonth, 3);
  const prevRecent3 = sumRecentMonths(monthlySales, currentYear - 1, currentMonth, 3);

  let momentum = 1;
  if (prevRecent3 > 0) momentum = clamp(recent3 / prevRecent3, 0.6, 2.5);
  else if (recent3 > 0) momentum = 1.2;

  const expected = clamp((ytdGrowth * 0.65) + (momentum * 0.35), 0.5, 3.5);

  return {
    expectedGrowthRate: expected,
    recentMomentumRate: momentum,
    recent3,
    prevRecent3
  };
}

function summarizeTrend(monthlyValues) {
  const positiveValues = monthlyValues.filter(v => v > 0);
  if (!positiveValues.length) return "판매 흐름 없음";

  if (monthlyValues.length >= 2) {
    const prev = monthlyValues[monthlyValues.length - 2];
    const last = monthlyValues[monthlyValues.length - 1];

    if (last > 0 && prev > 0 && last >= prev * 1.5) return "최근월 판매 증가";
    if (last > 0 && prev > 0 && last <= prev * 0.5) return "최근월 판매 감소";
  }

  if (positiveValues.length === 1) return "특정월 판매 집중";
  return "계절 판매 기준";
}

function forecastBySeason(row, leadTimeDays, productGrowthRate) {
  const today = new Date();

  const year = today.getFullYear();
  const month = today.getMonth() + 1;

  const leadMonths = Math.ceil(leadTimeDays / 30);

  let forecast = 0;
  const detail = [];
  const monthlyValues = [];

  for (let i = 0; i < leadMonths; i++) {
    const target = addMonths(year, month, i);

    const lastYearKey = monthKey(target.year - 1, target.month);
    const twoYearsAgoKey = monthKey(target.year - 2, target.month);
    const threeYearsAgoKey = monthKey(target.year - 3, target.month);

    const lastYearQty = num(row[lastYearKey]);
    const twoYearsAgoQty = num(row[twoYearsAgoKey]);
    const threeYearsAgoQty = num(row[threeYearsAgoKey]);

    let baseQty = 0;

    if (lastYearQty > 0) {
      baseQty = lastYearQty;
    } else {
      const oldValues = [twoYearsAgoQty, threeYearsAgoQty].filter(v => v > 0);
      baseQty = oldValues.length
        ? oldValues.reduce((a, b) => a + b, 0) / oldValues.length
        : 0;
    }

    const predicted = Math.round(baseQty * productGrowthRate);
    forecast += predicted;
    monthlyValues.push(predicted);

    detail.push(`${target.month}월:${predicted.toLocaleString()}`);
  }

  return {
    forecast: Math.round(forecast),
    monthlyForecast: Math.round(forecast / leadMonths),
    detail: detail.join(" / "),
    trendSummary: summarizeTrend(monthlyValues)
  };
}

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
      const productName =
        (row["품목명"] || row["품목별"] || row["품목"] || "").trim();

      if (!productName || productName.includes("총합계")) return null;

      const currentStock = num(row["현재고"]);
      const incomingStock = num(row["입고예정"]);
      const leadTime = num(row["리드타임"]) || 90;
      const manualOrder = row["발주제안"] || "";

      const availableStock = currentStock + incomingStock;

      const salesRow = salesMap[productName];

      let productGrowthRate = 1;
      let expectedGrowthRate = 1;
      let recentMomentumRate = 1;
      let seasonalForecast = 0;
      let monthlyForecast = 0;
      let forecastDetail = "-";
      let trendSummary = "판매 흐름 없음";
      let monthlySales = [];
      let yearlySales = [];

      if (salesRow) {
        productGrowthRate = calcProductGrowthRate(salesRow);

        const growth = calcExpectedGrowthRate(salesRow);
        expectedGrowthRate = growth.expectedGrowthRate;
        recentMomentumRate = growth.recentMomentumRate;

        const forecastResult = forecastBySeason(
          salesRow,
          leadTime,
          expectedGrowthRate
        );

        seasonalForecast = forecastResult.forecast;
        monthlyForecast = forecastResult.monthlyForecast;
        forecastDetail = forecastResult.detail;
        trendSummary = forecastResult.trendSummary;

        monthlySales = extractMonthlySales(salesRow);
        yearlySales = buildYearlySales(monthlySales);
      } else {
        seasonalForecast = num(row["작년판매"]);
        monthlyForecast = Math.round(seasonalForecast / Math.ceil(leadTime / 30));
        forecastDetail = "판매량 시트 매칭 없음";
        trendSummary = "판매량 매칭 필요";
      }

      const safetyStock = monthlyForecast;

      const shortage = Math.ceil(
        seasonalForecast + safetyStock - availableStock
      );

      const avgDailyForecast = monthlyForecast / 30;

      const daysLeft =
        avgDailyForecast > 0
          ? Math.round(availableStock / avgDailyForecast)
          : 9999;

      const stockoutDate = daysLeft === 9999 ? null : new Date(today);
      if (stockoutDate) {
        stockoutDate.setDate(today.getDate() + daysLeft);
      }

      const recommendedOrderDate = stockoutDate ? new Date(stockoutDate) : null;
      if (recommendedOrderDate) {
        recommendedOrderDate.setDate(stockoutDate.getDate() - leadTime);
      }

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
        if (orderDelayDays > 0) {
          action += ` / 발주 ${orderDelayDays}일 지연`;
        }
      } else if (daysLeft <= leadTime + 30) {
        status = "🟡 주의";
        action = "30일 내 발주 검토";
      }

      if (manualOrder) {
        action += ` / 기존 제안: ${manualOrder}`;
      }

      return {
        productName,
        currentStock,
        incomingStock,
        availableStock,
        leadTime,

        growthRate: Math.round(productGrowthRate * 100),
        expectedGrowthRate: Math.round(expectedGrowthRate * 100),
        recentMomentumRate: Math.round(recentMomentumRate * 100),

        monthlyForecast,
        seasonalForecast,
        forecastDetail,
        trendSummary,

        monthlySales,
        yearlySales,

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
          (Math.max(0, shortage) * 1000) +
          Math.max(0, 365 - Math.min(daysLeft, 365)) +
          (orderDelayDays * 100)
      };
    }).filter(Boolean);

    result.sort((a, b) => {
      const order = {
        "🔴 즉시발주": 1,
        "🟡 주의": 2,
        "🟢 안전": 3
      };

      if (order[a.status] !== order[b.status]) {
        return order[a.status] - order[b.status];
      }

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
  console.log("품목별 성장률 기반 발주 대시보드 실행 중");
});
