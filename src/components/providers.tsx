// ธีมมืดถูกกำหนดแบบ static ที่ <html className="dark"> ใน layout แล้ว —
// แอปไม่มีตัวสลับธีม จึงไม่ต้องใช้ next-themes (ตัว ThemeProvider ฝัง <script>
// รันไทม์ซึ่ง React 19 ขึ้น console error) คง Providers ไว้เป็นจุดรวม
// client provider ในอนาคต
export function Providers({ children }: { children: React.ReactNode }) {
  return children;
}
