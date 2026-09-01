import "./globals.css";

export const metadata = {
  title: "연세힐치과병원 | 강서구 임플란트 명가 - HEAL DENTAL HOSPITAL",
  description:
    "연세힐치과병원 - 서울 강서구 우장산역 임플란트 전문 치과. 임플란트, 일반진료, 치아성형, 사랑니발치. 외국인환자 유치 등록기관.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
