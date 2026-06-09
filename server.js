const express = require("express");
const XLSX = require("xlsx");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const FILE_PATH = path.join(__dirname, "data", "inventory.xlsx");

function toNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/,/g, "").trim();
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : 0;
}

function readInventoryExcel() {
  const workbook = XLSX.readFile(FILE_PATH);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  return rows.map((row) => {
    const productName = row["화분 크기"] || row["품목명"] || row["품목"] || "";
    const currentStock = toNumber(row["재고현황"] || row["현재고"] || row["재고"]);
    const incomingStock = toNumber(row["3, 4월 인보이스 합계 수량"] || row["인보이스 합계 수량"] || row["입고예정"]);
    const pastSales = toNumber(row["작년(25.06.01~25.12.01) 판매량"] || row["작년 하반기 판매량"] || row["예상판매량"]);
    const orderSuggestion = row["발주제안량"] || "";

    const availableStock = currentStock + incomingStock;
    const balance = availableStock - pastSales;
    const coverRate = pastSales > 0 ? availableStock / pastSales : null;

    let status = "🟢 안전";
    let priority = 3;
    let recommendation = "발주 보류";

    if (balance < 0) {
      status = "🔴 즉시발주";
      priority = 1;
      recommendation = `최소 ${Math.ceil(Math.abs(balance)).toLocaleString()}개 부족 예상`;
    } else if (coverRate !== null && coverRate < 1.3) {
      status = "🟡 주의";
      priority = 2;
      recommendation = "추가 발주 검토";
    } else if (pastSales === 0 && availableStock === 0) {
      status = "⚪ 데이터없음";
      priority = 4;
      recommendation = "판매이력/재고 확인 필요";
    }

    if (orderSuggestion) {
      recommendation += ` / 기존 제안: ${orderSuggestion}`;
    }

    return {
      productName,
      currentStock,
      incomingStock,
      availableStock,
      pastSales,
      balance,
      coverRate: coverRate === null ? null : Number(coverRate.toFixed(2)),
      status,
      priority,
      recommendation,
    };
  }).filter((item) => item.productName);
}

app.get("/api/inventory", (req, res) => {
  try {
    const data = readInventoryExcel().sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.balance - b.balance;
    });
    res.json(data);
  } catch (error) {
    res.status(500).json({
      error: "엑셀 분석 실패",
      message: error.message,
      hint: "data/inventory.xlsx 파일명이 맞는지 확인하세요.",
    });
  }
});

app.get("/api/summary", (req, res) => {
  try {
    const data = readInventoryExcel();
    const danger = data.filter((x) => x.status.includes("즉시")).length;
    const warning = data.filter((x) => x.status.includes("주의")).length;
    const safe = data.filter((x) => x.status.includes("안전")).length;
    const totalShortage = data.reduce((sum, x) => sum + (x.balance < 0 ? Math.abs(x.balance) : 0), 0);
    res.json({ danger, warning, safe, totalShortage: Math.ceil(totalShortage), totalItems: data.length });
  } catch (error) {
    res.status(500).json({ error: "요약 실패", message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`발주 대시보드 실행: http://localhost:${PORT}`);
});
