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

function formatDate(date) {
  if (!date || !isFinite(date.getTime())) return "-";
  return date.toISOString().slice(0, 10);
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

function getMonthColumns(row) {
  return Object.keys(row).filter(k => /^\d{4}[/-]\d{1,2}$/.test(k));
}

function monthKey(year, month) {
  return `${year}/${String(month).padStart(2, "0")}`;
}

function getYearMonth(date) {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1
  };
}

function addMonths(year, month, add) {
  const d = new Date(year, month - 1 + add, 1);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1
  };
}

function calcGrowthRate(salesRows) {
  const today = new Date();
  const currentYear = today.getFullYear();
  const prevYear = currentYear - 1;
  const currentMonth = today.getMonth() + 1;

  let currentTotal = 0;
  let prevTotal = 0;

  salesRows.forEach(row => {
    if ((row["품목별"] || row["품목명"] || "").includes("총합계")) return;

    for (let m = 1; m <= currentMonth; m++) {
      currentTotal += num(row[monthKey(currentYear, m)]);
      prevTotal += num(row[monthKey(prevYear, m)]);
    }
  });

  if (prevTotal <= 0) return 1;

  let rate = currentTotal / prevTotal;

  if (rate < 0.7) rate = 0.7;
  if (rate > 1.5) rate = 1.5;

  return rate;
}

function forecastBySeason(row, leadTimeDays, growthRate) {
  const today = new Date();
  const { year, month } = getYearMonth(today);

  const leadMonths = Math.ceil(leadTimeDays / 30);
  let forecast = 0;
  let detail = [];

  for (let i = 0; i < leadMonths; i++) {
    const target = addMonths(year, month, i);
    const lastYear = target.year - 1;

    const lastYearKey = monthKey(lastYear, target.month);
    const twoYearsKey = monthKey(lastYear - 1, target.month);
    const threeYearsKey = monthKey(lastYear - 2, target.month);

    const lastYearQty = num(row[lastYearKey]);
    const twoYearsQty = num(row[twoYearsKey]);
    const threeYearsQty = num(row[threeYearsKey]);

    let baseQty = 0;

    if (lastYearQty > 0) {
      baseQty = lastYearQty;
    } else {
      const values = [twoYearsQty, threeYearsQty].filter(v => v > 0);
      baseQty = values.length
        ? values.reduce((a, b) => a + b, 0) / values.length
        : 0;
    }

    const predicted = Math.round(baseQty * growthRate);
    forecast += predicted;

    detail.push(`${target.month}월:${predicted.toLocaleString()}`);
  }

  return {
    forecast: Math.round(forecast),
    detail: detail.join(" / "),
    monthlyAverage: Math.round(forecast / leadMonths)
  };
}

app.get("/api/inventory", async (req, res) => {
  try {
    const salesRows = await readSheet(SALES_SHEET);
    const stockRows = await readSheet(STOCK_SHEET);

    const growthRate = calcGrowthRate(salesRows);

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

      let seasonalForecast = 0;
      let forecastDetail = "-";
      let monthlyForecast = 0;

      if (salesRow) {
        const forecastResult = forecastBySeason(salesRow, leadTime, growthRate);
        seasonalForecast = forecastResult.forecast;
        forecastDetail = forecastResult.detail;
        monthlyForecast = forecastResult.monthlyAverage;
      } else {
        seasonalForecast = Math.round(num(row["작년판매"]) * growthRate);
        monthlyForecast = Math.round(seasonalForecast / Math.ceil(leadTime / 30));
        forecastDetail = "작년판매 기준";
      }

      const safetyStock = monthlyForecast;
      const shortage = Math.ceil(seasonalForecast + safetyStock - availableStock);

      const avgDailyForecast = monthlyForecast / 30;

      const daysLeft = avgDailyForecast > 0
        ? Math.round(availableStock / avgDailyForecast)
        : 9999;

      const stockoutDate = daysLeft === 9999 ? null : new Date(today);
      if (stockoutDate) stockoutDate.setDate(today.getDate() + daysLeft);

      const recommendedOrderDate = stockoutDate ? new Date(stockoutDate) : null;
      if (recommendedOrderDate) {
        recommendedOrderDate.setDate(stockoutDate.getDate() - leadTime);
      }

      let stockoutGroup = "안전";
      if (daysLeft <= 30) stockoutGroup = "🔥 30일 내 품절";
      else if (daysLeft <= 60) stockoutGroup = "🔥 60일 내 품절";
      else if (daysLeft <= 90) stockoutGroup = "🔥 90일 내 품절";

      let status = "🟢 안전";
      let action = "발주 보류";

      if (shortage > 0) {
        status = "🔴 즉시발주";
        action = `최소 ${Math.max(0, shortage).toLocaleString()}개 부족 예상`;
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
        growthRate: Math.round(growthRate * 100),
        seasonalForecast,
        monthlyForecast,
        forecastDetail,
        safetyStock,
        shortage: Math.max(0, shortage),
        daysLeft,
        stockoutDate: formatDate(stockoutDate),
        recommendedOrderDate: formatDate(recommendedOrderDate),
        stockoutGroup,
        status,
        action
      };
    }).filter(Boolean);

    result.sort((a, b) => {
      const order = {
        "🔴 즉시발주": 1,
        "🟡 주의": 2,
        "🟢 안전": 3
      };
      return order[a.status] - order[b.status];
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
  console.log("계절성 기반 발주 대시보드 실행 중");
});
