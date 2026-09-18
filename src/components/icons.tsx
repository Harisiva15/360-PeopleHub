/**
 * The icon set.
 *
 * One family, drawn as SVG, named by what it means rather than what it looks
 * like. Icons used to be emoji typed into each call site, which had three
 * problems worth fixing: emoji render as a different typeface on every
 * platform (so the product looked different on Windows, macOS and Android),
 * they cannot take a colour from the theme, and a glyph pasted into forty
 * files is forty places to change when it turns out to mean something else.
 *
 * **Named, not pasted.** `<Icon n="people" />` says what it is for. That
 * matters more than it sounds: the same drawing serves "employees", "a team"
 * and "headcount", and naming the *use* lets those diverge later without
 * hunting for which `👥` meant which.
 *
 * **Decorative by default.** An icon beside a label adds nothing for a screen
 * reader, so every icon here is `aria-hidden` and the label carries the
 * meaning. The exceptions are icons standing alone as a control, which take a
 * `title` and become a labelled image.
 */

import {
  AlertTriangle, Archive, ArrowLeftRight, Award, BadgeCheck, Banknote, BarChart3,
  Bell, Book, Briefcase, Building2, CalendarDays, CalendarClock, Check, CheckCircle2,
  ChevronRight, Clock, Coins, Compass, CreditCard, Divide as DivideIcon, DollarSign,
  FileCheck2, FileSpreadsheet, FileText, Filter, Flag, Gauge, Gift, GraduationCap,
  Grid3x3, HandHeart, Handshake, Hourglass, Inbox, Info, Laptop, Layers, LayoutDashboard,
  Lightbulb, LineChart, ListChecks, Mail, MapPin, Megaphone, MessageSquare, Menu,
  Paperclip, PartyPopper, PenLine, PieChart, Plane, Plus, Receipt, RefreshCw, Rocket,
  Search, Send, Settings, Share2, Shield, ShieldCheck, Sparkles, Star, Ticket, Timer,
  Trash2, TrendingDown, TrendingUp, Trophy, Undo2, UserCheck, UserPlus, UserRound,
  Users, Vote, Wallet, Wrench, X, Ban, Bed, Globe, Puzzle, PartyPopper as Celebrate,
  Download, Printer, ThumbsUp, ThumbsDown, MoreHorizontal, Eye, StopCircle, LayoutGrid,
  Car, UtensilsCrossed, Stethoscope, Hotel, Smartphone,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Every icon the product uses, by meaning.
 *
 * Kept as one object rather than scattered imports so the set stays small and
 * deliberate — a registry makes it obvious when somebody is about to add a
 * fifteenth vaguely-document-shaped icon.
 */
export const ICONS = {
  /* navigation */
  dashboard: LayoutDashboard,
  recruitment: Handshake,
  hiring: Compass,
  employees: Users,
  attendance: CalendarClock,
  timesheet: FileSpreadsheet,
  payroll: Banknote,
  performance: Gauge,
  projects: Layers,
  assets: Laptop,
  engagement: HandHeart,
  celebrations: Star,
  announcements: Megaphone,
  helpdesk: MessageSquare,
  reports: BarChart3,
  settings: Settings,
  security: Shield,
  learning: GraduationCap,
  leave: Plane,
  profile: UserRound,
  policy: Book,

  /* things */
  people: Users,
  person: UserRound,
  team: UserCheck,
  joiner: UserPlus,
  client: Building2,
  bank: Building2,
  money: Coins,
  rupee: DollarSign,
  wallet: Wallet,
  card: CreditCard,
  invoice: Receipt,
  payslip: FileCheck2,
  tax: FileSpreadsheet,
  document: FileText,
  attachment: Paperclip,
  note: PenLine,
  inbox: Inbox,
  mail: Mail,
  send: Send,
  submission: Send,
  calendar: CalendarDays,
  schedule: CalendarClock,
  clock: Clock,
  timer: Timer,
  hourglass: Hourglass,
  pending: Hourglass,
  slow: Timer,
  goal: ListChecks,
  target: ListChecks,
  trophy: Trophy,
  award: Award,
  star: Star,
  gift: Gift,
  cake: PartyPopper,
  party: Celebrate,
  balloon: Celebrate,
  applause: HandHeart,
  wave: HandHeart,
  rocket: Rocket,
  idea: Lightbulb,
  puzzle: Puzzle,
  globe: Globe,
  location: MapPin,
  laptop: Laptop,
  tool: Wrench,
  box: Archive,
  ticket: Ticket,
  vote: Vote,
  poll: Vote,
  rest: Bed,
  holiday: Plane,
  briefcase: Briefcase,
  building: Building2,
  chart: BarChart3,
  trend: LineChart,
  pie: PieChart,
  up: TrendingUp,
  down: TrendingDown,
  calculator: DivideIcon,

  /* states and actions */
  ok: Check,
  done: CheckCircle2,
  verified: BadgeCheck,
  warn: AlertTriangle,
  blocked: Ban,
  close: X,
  add: Plus,
  remove: Trash2,
  undo: Undo2,
  refresh: RefreshCw,
  swap: ArrowLeftRight,
  search: Search,
  filter: Filter,
  info: Info,
  flag: Flag,
  lock: ShieldCheck,
  share: Share2,
  menu: Menu,
  grid: Grid3x3,
  bell: Bell,
  next: ChevronRight,
  sparkle: Sparkles,
  section: Book,
  /* Exporting is not a downward trend. These earned their own entries when a
     bulk rename mapped them onto whatever was nearest. */
  download: Download,
  print: Printer,
  thumbsUp: ThumbsUp,
  thumbsDown: ThumbsDown,
  more: MoreHorizontal,
  view: Eye,
  stop: StopCircle,
  tiles: LayoutGrid,

  /* Categories the datasets name on their rows — expenses, benefits, tickets. */
  travel: Car,
  meal: UtensilsCrossed,
  health: Stethoscope,
  hotel: Hotel,
  phone: Smartphone,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/**
 * Sizes, so an icon in a tile and an icon in a button relate to each other
 * rather than each being whatever number was typed that day.
 */
const SIZES = { sm: 14, md: 16, lg: 20, xl: 26 } as const;

export function Icon({
  n, size = 'md', className, title, strokeWidth,
}: {
  n: IconName;
  size?: keyof typeof SIZES;
  className?: string;
  /**
   * Give an icon that stands alone as a control its own name. Omit it for an
   * icon beside a label — the label is already the name, and repeating it
   * makes a screen reader say everything twice.
   */
  title?: string;
  strokeWidth?: number;
}) {
  const C = ICONS[n];
  const px = SIZES[size];
  return (
    <C
      size={px}
      strokeWidth={strokeWidth ?? 1.9}
      className={'ic-svg' + (className ? ' ' + className : '')}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      aria-label={title}
    />
  );
}
