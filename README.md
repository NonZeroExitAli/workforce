# WorkForce Pro

A modern workforce management system for tracking attendance, shifts, and earnings with GPS validation and real-time dashboards.

Designed for small and medium teams needing reliable time tracking and payroll insights.

---

## Overview

WorkForce Pro is a browser-based workforce tracking solution that allows:

- Workers to clock in/out securely
- Managers to monitor attendance and productivity
- Automatic payroll calculations
- GPS-based work location validation
- Multi-language support

The system is optimized for deployment on serverless platforms and works across desktop and mobile devices.

---

## Features

### Worker Features
- Phone-based secure login  
- GPS verification before shift start  
- Start & end work shifts  
- Real-time work timer  
- Earnings calculation  
- Shift history access  
- Device protection (prevents unauthorized device access)  

### Manager Features
- Worker management dashboard  
- Add & approve workers  
- Assign workers to locations  
- Configure hourly rates  
- Live workforce status monitoring  
- Attendance & lateness tracking  
- Export reports (Excel/CSV)  
- Alert system for suspicious access  

### Location & GPS Control
- Location-based shift validation  
- Distance-based access control  
- Assign workers to specific job sites  
- Open/close locations in real time  

### Automation & Payroll
- Automatic shift duration calculation  
- Overtime & payroll calculation  
- Auto-end shifts at configured time  
- Salary and work-hour summaries  

### Internationalization
- Italian  
- Arabic (RTL supported)  

---

### Database Tables

Core tables include:

- `wf_users` — user accounts & roles  
- `wf_shifts` — work sessions  
- `wf_locations` — job sites & GPS coordinates  
- `wf_assignments` — worker-location assignments  
- `wf_phones` — approved phone numbers  
- `wf_alerts` — security & system alerts  
- `wf_config` — system configuration  

## Author
Ali Abdalhalim
