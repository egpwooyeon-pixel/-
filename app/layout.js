import "./globals.css";

export const metadata = {
  title: "도산공원 스컬트라 잘하는 밀리클리닉 | MILI CLINIC",
  description:
    "도산공원 밀리클리닉 - 울쎄라·써마지·튠페이스·스컬트라·핏컬트라 피부과. 원장 1:1 상담, 정품·정량 시술.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
