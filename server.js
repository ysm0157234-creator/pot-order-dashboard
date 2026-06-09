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

function monthColumns(row) {
  return Object.keys(row).filter(k => /^\d{4}[/-]\d{1,2}$/.test(k));
}

app.get("/api/inventory", async (req, res) => {
  try {
    const salesRows = await readSheet(SALES_SHEET);
    const stockRows = await readSheet(STOCK_SHEET);

    const salesMap = {};

    salesRows.forEach(row => {
      const name = row["품목별"] || row["품목명"] || row["품목"];
      if (!name || name.includes("총합계")) return;

      const months = monthColumns(row);
      const recentMonths = months.slice(-6);

      const recentTotal = recentMonths.reduce((sum, m) => sum + num(row[m]), 0);
      const avgMonthlySales = recentMonths.length ? recentTotal / recentMonths.length : 0;

      salesMap[name.trim()] = { avgMonthlySales };
    });

    const today = new Date();

    const result = stockRows.map(row => {
      const productName = (row["품목명"] || row["품목별"] || row["품목"] || "").trim();
      if (!productName || productName.includes("총합계")) return null;

      const currentStock = num(row["현재고"]);
      const incomingStock = num(row["입고예정"]);
      const leadTime = num(row["리드타임"]) || 90;
      const manualOrder = row["발주제안"] || "";

      const sales = salesMap[productName];

      const avgMonthlySales = sales
        ? sales.avgMonthlySales
        : num(row["작년판매"]) / 6;

      const availableStock = currentStock + incomingStock;
      const avgDailySales = avgMonthlySales / 30;

      const expectedSalesDuringLeadTime = avgDailySales * leadTime;
      const safetyStock = avgMonthlySales;

      const shortage = Math.ceil(
        expectedSalesDuringLeadTime + safetyStock - availableStock
      );

      const daysLeft = avgDailySales > 0
        ? Math.round(availableStock / avgDailySales)
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
        avgMonthlySales: Math.round(avgMonthlySales),
        leadTime,
        expectedSalesDuringLeadTime: Math.round(expectedSalesDuringLeadTime),
        safetyStock: Math.round(safetyStock),
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
  console.log("구글시트 연동 발주 대시보드 실행 중");
});
