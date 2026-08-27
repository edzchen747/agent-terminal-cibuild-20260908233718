import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;
const base = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

export const TerminalIcon = (props: IconProps) => <svg {...base} {...props}><path d="m5 7 4 4-4 4"/><path d="M11 17h7"/><rect x="2.5" y="3" width="19" height="18" rx="3"/></svg>;
export const FolderIcon = (props: IconProps) => <svg {...base} {...props}><path d="M3 7.5h7l2-2h9v13H3z"/></svg>;
export const PlusIcon = (props: IconProps) => <svg {...base} {...props}><path d="M12 5v14M5 12h14"/></svg>;
export const MenuIcon = (props: IconProps) => <svg {...base} {...props}><path d="M4 7h16M4 12h16M4 17h16"/></svg>;
export const PhoneIcon = (props: IconProps) => <svg {...base} {...props}><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/></svg>;
export const SettingsIcon = (props: IconProps) => <svg {...base} {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.9l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.9.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.2 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H2.4v-4h.1A1.7 1.7 0 0 0 4.2 8.6a1.7 1.7 0 0 0-.34-1.9l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 8.6 4.2a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1v-.1h4v.1a1.7 1.7 0 0 0 1 1.7 1.7 1.7 0 0 0 1.9-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 8.6a1.7 1.7 0 0 0 .6 1 1.7 1.7 0 0 0 1.1.4h.1v4h-.1a1.7 1.7 0 0 0-1.7 1Z"/></svg>;
export const BookmarkIcon = (props: IconProps) => <svg {...base} {...props}><path d="M6 3h12v18l-6-4-6 4z"/></svg>;
export const ClockIcon = (props: IconProps) => <svg {...base} {...props}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>;
export const CloseIcon = (props: IconProps) => <svg {...base} {...props}><path d="m7 7 10 10M17 7 7 17"/></svg>;
export const TrashIcon = (props: IconProps) => <svg {...base} {...props}><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14"/></svg>;
export const WifiIcon = (props: IconProps) => <svg {...base} {...props}><path d="M5 12.5a10 10 0 0 1 14 0M8 16a6 6 0 0 1 8 0M11 19.5a2 2 0 0 1 2 0"/></svg>;

