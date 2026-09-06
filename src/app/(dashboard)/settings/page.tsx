import { DesktopDevicesSection } from "@/components/settings/desktop-devices-section";
import { SettingsContent } from "./settings-content";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  return (
    <div className="ve-no-padding relative flex-1 overflow-y-auto isolate">
      <div className="relative z-10 px-4 md:px-6 pt-3 md:pt-4 pb-12">
        <SettingsContent desktopDevices={<DesktopDevicesSection />} />
      </div>
    </div>
  );
}
