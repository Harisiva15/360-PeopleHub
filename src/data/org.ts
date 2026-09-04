import type { Dept, GradeBand, Holiday, LeaveType, Project, Site } from '../types/org';
import type { Grade } from '../types/country';

export const ORG = {
  product: '360 People',                       /* the HR platform itself */
  productSub: 'HR & Workforce Platform',
  name: '360 Technology',
  legal: '360VHM Technology Private Limited',
  tagline: 'Integration | Insights | Innovation',
  cin: 'U72900TN2014PTC098231',
  pan: 'AAFC3600Q', tan: 'CHEA13600B',
  addr: 'Prestige Palladium, 5th Floor, OMR, Perungudi, Chennai 600096',
  fy: 'FY 2026-27', ay: 'AY 2027-28',
  weekOff: [0, 6]
};

export const SITES: Site[] = [
  { id: 'CHN', name: 'Chennai HQ', city: 'Chennai', country: 'IN', addr: 'Prestige Palladium, OMR, Perungudi', lat: 12.9911, lng: 80.2503, radius: 250, ptax: 208, tz: 'IST', shift: '09:30-18:30' },
  { id: 'BLR', name: 'Bengaluru Office', city: 'Bengaluru', country: 'IN', addr: 'Ecospace, Bellandur, ORR', lat: 12.9352, lng: 77.6245, radius: 220, ptax: 200, tz: 'IST', shift: '09:30-18:30' },
  { id: 'HYD', name: 'Hyderabad Office', city: 'Hyderabad', country: 'IN', addr: 'Cyber Towers, HITEC City, Madhapur', lat: 17.4435, lng: 78.3772, radius: 200, ptax: 200, tz: 'IST', shift: '10:00-19:00' },
  { id: 'NJ', name: 'New Jersey Office', city: 'East Brunswick', country: 'US', addr: '2 Tower Center Blvd, Suite 1101', lat: 40.4293, lng: -74.4074, radius: 250, ptax: 0, tz: 'EST', shift: '09:00-18:00' },
  { id: 'DAL', name: 'Dallas Office', city: 'Dallas', country: 'US', addr: '5001 Spring Valley Rd, Suite 400E', lat: 32.9268, lng: -96.7702, radius: 250, ptax: 0, tz: 'CST', shift: '09:00-18:00' },
  { id: 'TOR', name: 'Toronto Office', city: 'Toronto', country: 'CA', addr: '5140 Yonge Street, Suite 1600', lat: 43.7695, lng: -79.4128, radius: 220, ptax: 0, tz: 'EST', shift: '09:00-17:30' },
  { id: 'DXB', name: 'Dubai Office', city: 'Dubai', country: 'AE', addr: 'Building 3, Dubai Internet City', lat: 25.0942, lng: 55.1616, radius: 250, ptax: 0, tz: 'GST', shift: '09:00-18:00' },
  { id: 'LON', name: 'London Office', city: 'London', country: 'GB', addr: '30 Churchill Place, Canary Wharf', lat: 51.5045, lng: -0.0175, radius: 200, ptax: 0, tz: 'GMT', shift: '09:00-17:30' },
  { id: 'WFH', name: 'Work From Home', city: '—', country: 'IN', addr: 'Registered home address', lat: null, lng: null, radius: 0, ptax: 208, tz: 'IST', shift: '09:30-18:30' },
  { id: 'CLIENT', name: 'Client Site', city: '—', country: 'IN', addr: 'Customer premises (geo-logged)', lat: null, lng: null, radius: 0, ptax: 208, tz: 'IST', shift: 'Flexible' }
];
export const siteOf = (id: string): Site => SITES.find(s => s.id === id) || SITES[0];

export const DEPTS: Dept[] = [
  { id: 'ENG', name: 'Engineering', head: null, color: 'var(--s1)' },
  { id: 'QA', name: 'Quality Assurance', head: null, color: 'var(--s3)' },
  { id: 'DEVOPS', name: 'DevOps & Cloud', head: null, color: 'var(--s7)' },
  { id: 'PROD', name: 'Product & Design', head: null, color: 'var(--s2)' },
  { id: 'SALES', name: 'Sales & Marketing', head: null, color: 'var(--s4)' },
  { id: 'SUP', name: 'Customer Support', head: null, color: 'var(--s5)' },
  { id: 'HR', name: 'Human Resources', head: null, color: 'var(--s8)' },
  { id: 'FIN', name: 'Finance & Admin', head: null, color: 'var(--s6)' }
];
export const deptOf = (id: string): Dept => DEPTS.find(d => d.id === id) || { id, name: id, head: null, color: 'var(--s1)' };

export const GRADES: Record<Grade, GradeBand> = {
  L1: { label: 'L1 · Associate', min: 450000, max: 750000 },
  L2: { label: 'L2 · Engineer', min: 750000, max: 1300000 },
  L3: { label: 'L3 · Senior', min: 1300000, max: 2100000 },
  L4: { label: 'L4 · Lead / Manager', min: 2100000, max: 3400000 },
  L5: { label: 'L5 · Head', min: 3400000, max: 5500000 },
  L6: { label: 'L6 · Leadership', min: 5500000, max: 9000000 }
};

export const TITLES: Record<string, Record<Grade, string>> = {
  ENG: { L1: 'Associate Software Engineer', L2: 'Software Engineer', L3: 'Senior Software Engineer', L4: 'Engineering Manager', L5: 'Head of Engineering', L6: 'Chief Technology Officer' },
  QA: { L1: 'QA Trainee', L2: 'QA Engineer', L3: 'Senior QA Engineer', L4: 'QA Manager', L5: 'Head of Quality', L6: 'VP Quality' },
  DEVOPS: { L1: 'Cloud Associate', L2: 'DevOps Engineer', L3: 'Senior SRE', L4: 'DevOps Lead', L5: 'Head of Infrastructure', L6: 'VP Infrastructure' },
  PROD: { L1: 'Product Analyst', L2: 'Product Designer', L3: 'Senior Product Manager', L4: 'Design Lead', L5: 'Head of Product', L6: 'Chief Product Officer' },
  SALES: { L1: 'Sales Development Rep', L2: 'Account Executive', L3: 'Senior Account Manager', L4: 'Regional Sales Manager', L5: 'Head of Sales', L6: 'Chief Revenue Officer' },
  SUP: { L1: 'Support Associate', L2: 'Support Engineer', L3: 'Senior Support Engineer', L4: 'Support Manager', L5: 'Head of Customer Success', L6: 'VP Support' },
  HR: { L1: 'HR Associate', L2: 'HR Executive', L3: 'HR Business Partner', L4: 'Talent Acquisition Lead', L5: 'Head of People', L6: 'Chief People Officer' },
  FIN: { L1: 'Accounts Associate', L2: 'Accountant', L3: 'Finance Analyst', L4: 'Finance Manager', L5: 'Head of Finance', L6: 'Chief Financial Officer' }
};

export const FIRST_M = ['Arun', 'Karthik', 'Vignesh', 'Rahul', 'Aditya', 'Sanjay', 'Vivek', 'Prakash', 'Naveen', 'Rohit', 'Ashwin', 'Manoj', 'Siddharth', 'Ganesh', 'Dinesh', 'Harish', 'Nithin', 'Rajesh', 'Suresh', 'Balaji', 'Anand', 'Kiran', 'Praveen', 'Aravind', 'Gokul', 'Srinivas', 'Deepak', 'Mahesh', 'Ramesh', 'Yogesh', 'Sathish', 'Varun', 'Akhil', 'Tarun', 'Bharath'];
export const FIRST_F = ['Priya', 'Divya', 'Anitha', 'Meera', 'Kavya', 'Lakshmi', 'Sneha', 'Nandini', 'Swathi', 'Ramya', 'Deepika', 'Aishwarya', 'Vaishnavi', 'Pooja', 'Shreya', 'Janani', 'Keerthi', 'Nithya', 'Sowmya', 'Bhavana', 'Archana', 'Roshini', 'Malini', 'Yamini', 'Charulatha', 'Ishita', 'Tanvi', 'Anjali'];
export const LAST = ['Raghavan', 'Krishnan', 'Subramanian', 'Iyer', 'Nair', 'Menon', 'Reddy', 'Rao', 'Sharma', 'Verma', 'Gupta', 'Patel', 'Desai', 'Joshi', 'Kulkarni', 'Bhat', 'Shetty', 'Pillai', 'Chandran', 'Murthy', 'Prasad', 'Mohan', 'Natarajan', 'Venkatesh', 'Srinivasan', 'Kumar', 'Balan', 'Ravi', 'Sundaram', 'Thakur'];

export const BANKS = ['HDFC Bank', 'ICICI Bank', 'State Bank of India', 'Axis Bank', 'Kotak Mahindra Bank'];
export const BLOOD = ['O+', 'A+', 'B+', 'AB+', 'O-', 'A-', 'B-'];
export const SKILLS = ['React', 'Node.js', 'Java', 'Spring Boot', 'Python', 'AWS', 'Kubernetes', 'Docker', 'PostgreSQL', 'TypeScript', 'Selenium', 'Cypress', 'Terraform', 'Figma', 'Salesforce', 'Kafka', 'GraphQL', 'Azure', 'Go', 'Flutter'];

export const HOLIDAYS: Holiday[] = [
  { d: '2026-01-01', n: "New Year's Day", opt: false }, { d: '2026-01-14', n: 'Pongal', opt: false },
  { d: '2026-01-15', n: 'Thiruvalluvar Day', opt: true }, { d: '2026-01-26', n: 'Republic Day', opt: false },
  { d: '2026-03-04', n: 'Holi', opt: true }, { d: '2026-04-03', n: 'Good Friday', opt: false },
  { d: '2026-04-14', n: 'Tamil New Year / Ambedkar Jayanti', opt: false }, { d: '2026-05-01', n: 'May Day', opt: false },
  { d: '2026-08-15', n: 'Independence Day', opt: false }, { d: '2026-09-14', n: 'Vinayagar Chaturthi', opt: true },
  { d: '2026-10-02', n: 'Gandhi Jayanti', opt: false }, { d: '2026-10-20', n: 'Ayudha Pooja', opt: false },
  { d: '2026-10-21', n: 'Vijaya Dashami', opt: false }, { d: '2026-11-08', n: 'Deepavali', opt: false },
  { d: '2026-12-25', n: 'Christmas', opt: false }
];
export const HOLIDAY_MAP: Record<string, string> = {};
HOLIDAYS.forEach((h) => {
  if (!h.opt) HOLIDAY_MAP[h.d] = h.n;
});

export const LEAVE_TYPES: LeaveType[] = [
  { id: 'CL', name: 'Casual Leave', quota: 12, color: 'var(--s1)', carry: false, encash: false },
  { id: 'SL', name: 'Sick Leave', quota: 12, color: 'var(--s2)', carry: false, encash: false },
  { id: 'EL', name: 'Earned / Privilege Leave', quota: 15, color: 'var(--s3)', carry: true, cap: 30, encash: true },
  { id: 'CO', name: 'Comp Off', quota: 0, color: 'var(--s7)', carry: false, encash: false },
  { id: 'ML', name: 'Maternity Leave', quota: 182, color: 'var(--s5)', carry: false, encash: false, gender: 'F' },
  { id: 'PL', name: 'Paternity Leave', quota: 5, color: 'var(--s4)', carry: false, encash: false, gender: 'M' },
  { id: 'LOP', name: 'Loss of Pay', quota: 0, color: 'var(--s8)', carry: false, encash: false }
];
export const ltOf = (id: string): LeaveType => LEAVE_TYPES.find(l => l.id === id) || LEAVE_TYPES[0];
/* leave types that form the annual balance 'bank' — statutory event leave is excluded from totals */
export const BANKABLE = ['CL', 'SL', 'EL', 'CO'];

export const PROJECTS: Project[] = [
  { id: 'P-ATLAS', name: 'Atlas Core Platform', client: 'Internal', billable: false, color: 'var(--s1)' },
  { id: 'P-NBFC', name: 'Meridian NBFC Portal', client: 'Meridian Finance', billable: true, color: 'var(--s2)' },
  { id: 'P-RETAIL', name: 'RetailOne Commerce', client: 'RetailOne Group', billable: true, color: 'var(--s3)' },
  { id: 'P-HEALTH', name: 'CareLink Health Cloud', client: 'CareLink Hospitals', billable: true, color: 'var(--s4)' },
  { id: 'P-LOGI', name: 'TransitIQ Logistics', client: 'Transit Global', billable: true, color: 'var(--s7)' },
  { id: 'P-INT', name: 'Internal Tools & HRMS', client: 'Internal', billable: false, color: 'var(--s5)' },
  { id: 'P-SUP', name: 'Managed Support Desk', client: 'Multiple', billable: true, color: 'var(--s6)' },
  { id: 'P-PRESALES', name: 'Pre-Sales & Solutioning', client: 'Internal', billable: false, color: 'var(--s8)' }
];
export const projOf = (id: string): Project => PROJECTS.find(p => p.id === id) || PROJECTS[0];
export const TASK_TYPES: string[] = ['Development', 'Code Review', 'Testing', 'Bug Fix', 'Design', 'Meetings', 'Documentation', 'Deployment', 'Support', 'Training'];

