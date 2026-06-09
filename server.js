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

function latestMonthColumns(row) {
  return Object.keys(row).filter(k =>
    /^\d{4}[/-]\d{1,2}$/.test(k)
  );
}

app.get("/api/inventory", async (req, res) => {
  try {
    const salesRows = await readSheet(SALES_SHEET);
    const stockRows = await readSheet(STOCK_SHEET);

    const salesMap = {};

    salesRows.forEach(row => {
      const name = row["품목별"] || row["품목명"] || row["품목"];
      if (!name || name.includes("총합계")) return;

      const months = latestMonthColumns(row);
      const recentMonths = months.slice(-6);

      const recentTotal = recentMonths.reduce((sum, m) => sum + num(row[m]), 0);
      const avgMonthlySales = recentMonths.length ? recentTotal / recentMonths.length : 0;

      salesMap[name.trim()] = {
        avgMonthlySales,
        months
      };
    });

    const result = stockRows.map(row => {
      const name = row["품목명"] || row["화분 크기"] || row["품목"];
      if (!name) return null;

      const productName = name.trim();

      const currentStock = num(row["현재고"]);
      const incomingStock = num(row["입고예정"]);
      const leadTime = num(row["리드타임"]) || 90;
      const manualOrder = row["발주제안"] || "";

      const sales = salesMap[productName];
      const avgMonthlySales = sales ? sales.avgMonthlySales : num(row["작년판매"]) / 6;

      const availableStock = currentStock + incomingStock;
      const expectedSalesDuringLeadTime = avgMonthlySales / 30 * leadTime;
      const safetyStock = avgMonthlySales;
      const shortage = Math.ceil(expectedSalesDuringLeadTime + safetyStock - availableStock);

      const daysLeft = avgMonthlySales > 0
        ? Math.round(availableStock / (avgMonthlySales / 30))
        : 9999;

      let status = "🟢 안전";
      let action = "발주 보류";

      if (shortage > 0) {
        status = "🔴 즉시발주";
        action = `최소 ${shortage.toLocaleString()}개 부족 예상`;
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
        daysLeft,
        shortage: Math.max(0, shortage),
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
    res.status(500).json({
      error: "구글시트 연동 실패",
      message: err.message
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("구글시트 연동 발주 대시보드 실행 중");
});
