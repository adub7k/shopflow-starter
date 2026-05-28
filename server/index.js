const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const low       = require('lowdb');
const FileSync  = require('lowdb/adapters/FileSync');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Path resolution ───────────────────────────────────────────────────────────
function findClientDir() {
  const candidates = [
    path.join(__dirname, '..', 'client'),
    path.join(__dirname, 'client'),
    path.join(process.cwd(), 'client'),
    path.join(process.cwd(), '..', 'client'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      console.log('Client found at:', dir);
      return dir;
    }
  }
  return candidates[0];
}
const CLIENT_DIR = findClientDir();
const ROOT = path.dirname(CLIENT_DIR);

// ── Database ──────────────────────────────────────────────────────────────────
// Uses /data when Railway volume is mounted, falls back to local ./data for dev
const VOLUME_DIR = '/data';
const LOCAL_DIR  = path.join(ROOT, 'data');
const DATA_DIR   = fs.existsSync(VOLUME_DIR) ? VOLUME_DIR : (process.env.DATA_DIR || LOCAL_DIR);
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
console.log('ShopFlow data directory:', DATA_DIR);
const adapter = new FileSync(path.join(DATA_DIR, 'shopflow.json'));
const db = low(adapter);

const genId  = (p='x') => p+Date.now().toString(36)+Math.random().toString(36).slice(2,5);
const getAll = (col)   => db.get(col).value()||[];
const getById= (col,id)=> db.get(col).find({id}).value();
const upsert = (col,item) => { if(db.get(col).find({id:item.id}).value()) db.get(col).find({id:item.id}).assign(item).write(); else db.get(col).push(item).write(); };
const remove = (col,id)=> db.get(col).remove({id}).write();
const today  = ()=> new Date().toISOString().split('T')[0];
const d      = (n)=> new Date(Date.now()-n*86400000).toISOString().split('T')[0];

// ── Seed ──────────────────────────────────────────────────────────────────────
db.defaults({
  settings:{
    shopName:'My Barbershop',
    tagline:'Walk-ins Welcome.',
    phone:'',
    address:'',
    email:'',
    bookingEnabled:true,
    bookingMessage:'Book your appointment below. We\'ll confirm your spot!',
    accentColor:'#16a34a',
    pin:'1234',
    pinEnabled:true,
    loyalty:{ enabled:true, visitsForReward:10, rewardDescription:'One free haircut' },
    twilio:{ accountSid:'', authToken:'', fromNumber:'' },
    googleReviewLink:'',
    emailSmtp:{ host:'', port:587, user:'', pass:'' },
    remindersSent:[],
  },
  barbers:[
    { id:'b1', name:'Barber 1', chair:1, phone:'', bio:'', color:'#16a34a', active:true, joinedAt:d(180),
      schedule:{ workDays:[1,2,3,4,5,6], startTime:'9:00 AM', endTime:'6:00 PM', slotMinutes:30 } },
    { id:'b2', name:'Barber 2', chair:2, phone:'', bio:'', color:'#2563eb', active:true, joinedAt:d(90),
      schedule:{ workDays:[1,2,3,4,5,6], startTime:'9:00 AM', endTime:'6:00 PM', slotMinutes:30 } },
  ],
  blockedDates:[],
  services:[
    { id:'s1', name:'Haircut',        category:'cut',   price:35, duration:45 },
    { id:'s2', name:'Fade',           category:'cut',   price:35, duration:45 },
    { id:'s3', name:'Taper',          category:'cut',   price:30, duration:40 },
    { id:'s4', name:'Beard Lineup',   category:'beard', price:15, duration:20 },
    { id:'s5', name:'Cut + Beard',    category:'combo', price:50, duration:60 },
    { id:'s6', name:'Kids Cut',       category:'cut',   price:25, duration:30 },
  ],
  customers:[],
  appointments:[],
  conversations:[],
}).write();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin:'*' }));
app.use(express.json({ limit:'2mb' }));
app.use(express.static(CLIENT_DIR));
app.use('/api', rateLimit({ windowMs:60000, max:300 }));

// ── Auth ──────────────────────────────────────────────────────────────────────
app.post('/api/auth/verify', (req,res) => {
  const { pin } = req.body;
  const s = db.get('settings').value()||{};
  if (s.pinEnabled===false) return res.json({ok:true});
  res.json(String(pin)===String(s.pin||'1234') ? {ok:true} : {ok:false,error:'Incorrect PIN'});
});
app.post('/api/auth/change-pin', (req,res) => {
  const {currentPin,newPin} = req.body;
  const s = db.get('settings').value()||{};
  if (String(currentPin)!==String(s.pin||'1234')) return res.status(401).json({ok:false,error:'Current PIN incorrect'});
  if (!newPin||String(newPin).length<4) return res.status(400).json({ok:false,error:'PIN must be 4+ digits'});
  db.get('settings').assign({pin:String(newPin)}).write();
  res.json({ok:true});
});

// PIN reset via owner secret key (set OWNER_KEY env var in Railway)
app.post('/api/auth/reset-pin', (req,res) => {
  const {ownerKey, newPin} = req.body;
  const key = process.env.OWNER_KEY||'shopflow2026';
  if (String(ownerKey)!==String(key)) return res.status(401).json({ok:false,error:'Invalid owner key'});
  if (!newPin||String(newPin).length<4) return res.status(400).json({ok:false,error:'PIN must be 4+ digits'});
  db.get('settings').assign({pin:String(newPin)}).write();
  res.json({ok:true});
});

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/api/settings', (req,res) => res.json(db.get('settings').value()||{}));
app.post('/api/settings', (req,res) => { db.get('settings').assign(req.body).write(); res.json({ok:true}); });

// ── Barbers ───────────────────────────────────────────────────────────────────
app.get('/api/barbers', (req,res) => res.json(getAll('barbers').filter(b=>b.active!==false)));
app.post('/api/barbers', (req,res) => { const b=req.body; if(!b.id)b.id=genId('b'); upsert('barbers',b); res.json({id:b.id}); });
app.delete('/api/barbers/:id', (req,res) => { remove('barbers',req.params.id); res.json({ok:true}); });

// ── Services ──────────────────────────────────────────────────────────────────
app.get('/api/services', (req,res) => res.json(getAll('services').sort((a,b)=>a.category.localeCompare(b.category))));
app.post('/api/services', (req,res) => { const s=req.body; if(!s.id)s.id=genId('s'); upsert('services',s); res.json({id:s.id}); });
app.delete('/api/services/:id', (req,res) => { remove('services',req.params.id); res.json({ok:true}); });

// ── Customers ─────────────────────────────────────────────────────────────────
app.get('/api/customers', (req,res) => {
  try {
    const customers = getAll('customers');
    const appointments = getAll('appointments');
    // Build lookup maps once instead of scanning per customer
    const visitCount = {}, lastVisit = {};
    appointments.forEach(a => {
      if (a.status==='done' && a.customerId) {
        visitCount[a.customerId] = (visitCount[a.customerId]||0) + 1;
        if (!lastVisit[a.customerId] || a.date > lastVisit[a.customerId]) {
          lastVisit[a.customerId] = a.date;
        }
      }
    });
    res.json(customers.sort((a,b)=>(a.name||'').localeCompare(b.name||'')).map(c=>({
      ...c,
      totalVisits: visitCount[c.id]||0,
      lastVisit:   lastVisit[c.id]||null,
    })));
  } catch(e) {
    console.error('Customers GET error:', e.message);
    res.status(500).json({error:'Server error'});
  }
});
app.get('/api/customers/search', (req,res) => {
  const q=(req.query.q||'').toLowerCase();
  res.json(getAll('customers').filter(c=>c.name.toLowerCase().includes(q)||(c.phone||'').includes(q)).slice(0,10));
});
app.get('/api/customers/:id', (req,res) => {
  const c=getById('customers',req.params.id); if(!c)return res.status(404).json({error:'Not found'});
  const appts=getAll('appointments').filter(a=>a.customerId===c.id).sort((a,b)=>new Date(b.date)-new Date(a.date));
  const done=appts.filter(a=>a.status==='done');
  const loyalty=(db.get('settings').value()||{}).loyalty||{visitsForReward:10};
  res.json({customer:c,appointments:appts,totalVisits:done.length,totalRevenue:done.reduce((s,a)=>s+Number(a.price||0),0),loyaltyPoints:c.loyaltyPoints||0,rewardReady:(c.loyaltyPoints||0)>=(loyalty.visitsForReward||10),visitsForReward:loyalty.visitsForReward||10});
});
app.post('/api/customers', (req,res) => { const c=req.body; if(!c.id)c.id=genId('c'); upsert('customers',c); res.json({id:c.id}); });
app.delete('/api/customers/:id', (req,res) => { remove('customers',req.params.id); res.json({ok:true}); });
app.post('/api/customers/:id/redeem', (req,res) => { const c=getById('customers',req.params.id); if(c){c.loyaltyPoints=0;upsert('customers',c);} res.json({ok:true}); });

// ── Appointments ──────────────────────────────────────────────────────────────
app.get('/api/appointments', (req,res) => {
  const { date, month } = req.query;
  const barbers = getAll('barbers'), customers = getAll('customers');
  let appts = getAll('appointments');
  if (date)  appts = appts.filter(a=>a.date===date);
  if (month) appts = appts.filter(a=>(a.date||'').startsWith(month));
  res.json(appts.sort((a,b)=>(a.date+a.time).localeCompare(b.date+b.time)).map(a=>({
    ...a,
    barberColor: barbers.find(b=>b.id===a.barberId)?.color||'#ccc',
    customerPhone: a.customerId ? customers.find(c=>c.id===a.customerId)?.phone||'' : a.customerPhone||'',
  })));
});
app.post('/api/appointments', (req,res) => {
  const a=req.body; if(!a.id)a.id=genId('a');

  // ALWAYS ensure customer exists for any appointment — no orphaned appointments
  if(a.customerName) {
    const digits=(a.customerPhone||'').replace(/[^0-9]/g,'');
    let cust = a.customerId ? getById('customers',a.customerId) : null;

    // Try match by phone if no customerId or customer not found
    if(!cust && digits.length>=10) {
      cust = getAll('customers').find(c=>(c.phone||'').replace(/[^0-9]/g,'')===digits);
    }

    if(cust) {
      // Update existing customer — fill in any missing info
      a.customerId = cust.id;
      if(!cust.phone && a.customerPhone) { cust.phone=a.customerPhone; upsert('customers',cust); }
      if(!cust.preferredBarberId && a.barberId) { cust.preferredBarberId=a.barberId; upsert('customers',cust); }
    } else {
      // Create new customer profile
      const cid = genId('c');
      upsert('customers',{
        id:cid, name:a.customerName,
        phone:a.customerPhone||'',
        email:a.customerEmail||'',
        source:a.source||'crm',
        notes:'', loyaltyPoints:0, noShows:0,
        preferredBarberId:a.barberId||null,
        createdAt:today()
      });
      a.customerId = cid;
    }
  }

  upsert('appointments',a);
  scheduleReminder(a);
  res.json({id:a.id});
});
app.post('/api/appointments/:id/complete', (req,res) => {
  const a=getById('appointments',req.params.id); if(!a)return res.status(404).json({error:'Not found'});
  a.status='done'; a.price=req.body.price||a.price||0;
  upsert('appointments',a);
  // Award loyalty point
  if(a.customerId){const c=getById('customers',a.customerId);if(c){c.loyaltyPoints=(c.loyaltyPoints||0)+1;c.lastJobDate=a.date;upsert('customers',c);}}
  res.json({ok:true});
});

app.post('/api/appointments/:id/noshow', (req,res) => {
  const a=getById('appointments',req.params.id); if(!a)return res.status(404).json({error:'Not found'});
  a.status='no-show'; a.noShowAt=new Date().toISOString();
  upsert('appointments',a);
  // Track no-show on customer profile
  if(a.customerId){
    const c=getById('customers',a.customerId);
    if(c){ c.noShows=(c.noShows||0)+1; upsert('customers',c); }
  }
  res.json({ok:true});
});
app.delete('/api/appointments/:id', (req,res) => { remove('appointments',req.params.id); res.json({ok:true}); });

// ── Revenue ───────────────────────────────────────────────────────────────────
app.get('/api/revenue', (req,res) => {
  const done = getAll('appointments').filter(a=>a.status==='done');
  const ms = today().slice(0,7)+'-01';
  const thisMonth = done.filter(a=>a.date>=ms);
  const barbers = getAll('barbers');
  const byBarber = {};
  done.forEach(a=>{ if(!byBarber[a.barberId])byBarber[a.barberId]={name:a.barberName||'Unknown',color:barbers.find(b=>b.id===a.barberId)?.color||'#ccc',revenue:0,count:0}; byBarber[a.barberId].revenue+=Number(a.price||0); byBarber[a.barberId].count++; });
  // Monthly breakdown
  const byMonth={};
  done.forEach(a=>{ const m=(a.date||'').slice(0,7); if(!byMonth[m])byMonth[m]=0; byMonth[m]+=Number(a.price||0); });
  res.json({
    totalRevenue: done.reduce((s,a)=>s+Number(a.price||0),0),
    monthRevenue: thisMonth.reduce((s,a)=>s+Number(a.price||0),0),
    monthJobs:    thisMonth.length,
    avgTicket:    thisMonth.length?Math.round(thisMonth.reduce((s,a)=>s+Number(a.price||0),0)/thisMonth.length):0,
    byBarber:     Object.values(byBarber).sort((a,b)=>b.revenue-a.revenue),
    byMonth:      Object.entries(byMonth).sort((a,b)=>a[0].localeCompare(b[0])).map(([month,revenue])=>({month,revenue})),
    recentDone:   done.sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,5),
    loyaltyAlerts: (() => { try { const l=db.get('settings').value()?.loyalty||{enabled:true,visitsForReward:10}; return l.enabled?getAll('customers').filter(c=>(c.loyaltyPoints||0)>=(l.visitsForReward||10)):[];} catch(e){return[];} })(),
  });
});

// ── Conversations ─────────────────────────────────────────────────────────────
app.get('/api/conversations/customer/:cid', (req,res) => res.json(getAll('conversations').filter(c=>c.customerId===req.params.cid).sort((a,b)=>new Date(a.sentAt)-new Date(b.sentAt))));
app.post('/api/conversations', (req,res) => { const c=req.body; if(!c.id)c.id=genId('msg'); upsert('conversations',c); res.json({id:c.id}); });

// ── SMS ───────────────────────────────────────────────────────────────────────
app.post('/api/sms/send', async (req,res) => {
  const {to,body,customerId,customerName}=req.body;
  const cfg=(db.get('settings').value()||{}).twilio||{};
  if(!cfg.accountSid||!cfg.authToken||!cfg.fromNumber) return res.json({ok:false,error:'Twilio not configured. Go to Settings → Messaging.'});
  try {
    const twilio=require('twilio')(cfg.accountSid,cfg.authToken);
    await twilio.messages.create({from:cfg.fromNumber,to:'+1'+to.replace(/\D/g,''),body});
    upsert('conversations',{id:genId('msg'),customerId,customerName,type:'sms',direction:'outbound',body,sentAt:new Date().toISOString(),read:true});
    res.json({ok:true});
  } catch(e){ res.json({ok:false,error:e.message}); }
});

// ── Client-facing booking API ─────────────────────────────────────────────────
app.get('/api/booking/info', (req,res) => {
  try {
    const s=db.get('settings').value()||{};
    const barbers=getAll('barbers').filter(b=>b.active!==false);
    const services=getAll('services');
    const blockedDates=getAll('blockedDates').map(b=>b.date);
    res.json({
      shopName:s.shopName||'My Barbershop',
      tagline:s.tagline||'Walk-ins Welcome.',
      bookingMessage:s.bookingMessage||'Book your appointment below!',
      accentColor:s.accentColor||'#16a34a',
      bookingEnabled:s.bookingEnabled!==false,
      barbers,
      services,
      blockedDates,
    });
  } catch(e) {
    console.error('Booking info error:', e.message);
    res.status(500).json({error:'Server error', message:e.message});
  }
});

// ── Smart availability ────────────────────────────────────────────────────────
function generateSlots(startTime, endTime, slotMinutes) {
  const slots = [];
  const parseTime = (t) => {
    const [time, ampm] = t.split(' ');
    let [h, m] = time.split(':').map(Number);
    if (ampm === 'PM' && h !== 12) h += 12;
    if (ampm === 'AM' && h === 12) h = 0;
    return h * 60 + m;
  };
  const formatTime = (mins) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2,'0')} ${ampm}`;
  };
  const start = parseTime(startTime||'9:00 AM');
  const end   = parseTime(endTime||'6:00 PM');
  const step  = slotMinutes||30;
  for (let t = start; t < end; t += step) slots.push(formatTime(t));
  return slots;
}

app.get('/api/booking/availability', (req,res) => {
  const { date, barberId } = req.query;
  if (!date) return res.json([]);

  // Check if date is blocked
  const blocked = getAll('blockedDates').find(b=>b.date===date);
  if (blocked) return res.json([]);

  // Check if date is in the past
  const today = new Date(); today.setHours(0,0,0,0);
  const reqDate = new Date(date+'T12:00:00');
  if (reqDate < today) return res.json([]);

  // Get barber schedule
  const barbers = getAll('barbers').filter(b=>b.active!==false);
  let workingBarbers = barberId ? barbers.filter(b=>b.id===barberId) : barbers;

  // Check day of week (0=Sun, 1=Mon...6=Sat)
  const dow = new Date(date+'T12:00:00').getDay();
  workingBarbers = workingBarbers.filter(b => {
    const wd = b.schedule?.workDays||[1,2,3,4,5,6];
    return wd.includes(dow);
  });

  if (!workingBarbers.length) return res.json([]);

  // Build available slots based on barber schedule
  // If multiple barbers, use the union of all their slots
  const allSlotSets = workingBarbers.map(b => {
    const sched = b.schedule || { startTime:'9:00 AM', endTime:'6:00 PM', slotMinutes:30 };
    const slots = generateSlots(sched.startTime, sched.endTime, sched.slotMinutes);
    // Remove booked slots for this barber
    const booked = getAll('appointments').filter(a=>
      a.date===date &&
      (a.status==='confirmed'||a.status==='in-progress') &&
      a.barberId===b.id
    ).map(a=>a.time);
    return slots.filter(s=>!booked.includes(s));
  });

  // If specific barber requested, return their slots
  if (barberId) return res.json(allSlotSets[0]||[]);

  // For no-preference, return slots where AT LEAST ONE barber is free
  const allSlots = [...new Set(allSlotSets.flat())].sort((a,b)=>{
    const parse = t => { const [time,ap]=t.split(' ');let [h,m]=time.split(':').map(Number);if(ap==='PM'&&h!==12)h+=12;if(ap==='AM'&&h===12)h=0;return h*60+m; };
    return parse(a)-parse(b);
  });
  res.json(allSlots);
});

app.post('/api/booking/request', async (req,res) => {
  const { customerName, customerPhone, customerEmail, barberId, barberName, serviceId, serviceName, servicePrice, date, time, notes } = req.body;
  if (!customerName||!customerPhone||!date||!time) return res.status(400).json({ok:false,error:'Missing required fields'});
  const apptId = genId('a');
  // Always look up price from DB — don't trust client-sent price
  const svcFromDb = serviceId ? getAll('services').find(s=>s.id===serviceId) : null;
  const confirmedPrice = svcFromDb ? Number(svcFromDb.price) : Number(servicePrice)||35;
  const confirmedDuration = svcFromDb ? Number(svcFromDb.duration)||45 : 45;
  const appt = { id:apptId, customerName, customerPhone, customerEmail:customerEmail||'', barberId:barberId||null, barberName:barberName||null, serviceId:serviceId||null, service:serviceName||'Haircut', price:confirmedPrice, duration:confirmedDuration, date, time, status:'confirmed', notes:notes||'', source:'booking-page', createdAt:new Date().toISOString() };
  // Save appointment (auto-creates customer)
  const fakeReq={body:appt};
  const digits=(customerPhone||'').replace(/[^0-9]/g,'');
  const existing=getAll('customers').find(c=>(c.phone||'').replace(/[^0-9]/g,'')===digits);
  if(existing){appt.customerId=existing.id;}
  else if(digits.length>=10){const cid=genId('c');upsert('customers',{id:cid,name:customerName,phone:customerPhone,email:customerEmail||'',source:'booking-page',notes:'',loyaltyPoints:0,preferredBarberId:barberId||null,createdAt:today()});appt.customerId=cid;}
  upsert('appointments',appt);
  // Send confirmation text
  const s=db.get('settings').value()||{};
  const cfg=s.twilio||{};
  let smsSentFlag = false;

  // Try SMS first
  if(cfg.accountSid&&cfg.authToken&&cfg.fromNumber&&digits.length>=10){
    try {
      const twilio=require('twilio')(cfg.accountSid,cfg.authToken);
      const msg=`Hi ${customerName.split(' ')[0]}! Your appointment at ${s.shopName||'the shop'} is confirmed for ${date} at ${time}${barberName?' with '+barberName:''}. See you then! ✂️`;
      await twilio.messages.create({from:cfg.fromNumber,to:'+1'+digits,body:msg});
      upsert('conversations',{id:genId('msg'),customerId:appt.customerId,customerName,type:'sms',direction:'outbound',body:msg,sentAt:new Date().toISOString(),read:true});
      smsSentFlag = true;
    } catch(e){ console.log('Booking SMS failed:',e.message); }
  }

  // Email confirmation fallback — fires if SMS not sent and email provided
  if(!smsSentFlag && customerEmail) {
    try {
      const nodemailer = require('nodemailer');
      const emailCfg = s.emailSmtp||{};
      if(emailCfg.host&&emailCfg.user&&emailCfg.pass) {
        const transporter = nodemailer.createTransport({
          host:emailCfg.host, port:emailCfg.port||587, secure:false,
          auth:{user:emailCfg.user,pass:emailCfg.pass}
        });
        await transporter.sendMail({
          from: `"${s.shopName||'ShopFlow'}" <${emailCfg.user}>`,
          to: customerEmail,
          subject: `Appointment Confirmed — ${s.shopName||'ShopFlow'}`,
          html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;">
            <h2 style="color:#16a34a;">You're booked! ✂️</h2>
            <p style="color:#374151;">Hi ${customerName.split(' ')[0]}, your appointment is confirmed.</p>
            <div style="background:#f0fdf4;border:1px solid #dcfce7;border-radius:10px;padding:16px;margin:20px 0;">
              <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #dcfce7;"><span style="color:#6b7280;">Service</span><strong>${serviceName||'Appointment'}</strong></div>
              ${barberName?`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #dcfce7;"><span style="color:#6b7280;">Barber</span><strong>${barberName}</strong></div>`:''}
              <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #dcfce7;"><span style="color:#6b7280;">Date</span><strong>${date}</strong></div>
              <div style="display:flex;justify-content:space-between;padding:6px 0;"><span style="color:#6b7280;">Time</span><strong>${time}</strong></div>
            </div>
            <p style="color:#6b7280;font-size:13px;">We'll see you then! If you need to reschedule please contact us.</p>
            <p style="color:#9ca3af;font-size:11px;margin-top:24px;">Powered by ShopFlow</p>
          </div>`
        });
        smsSentFlag = true;
        console.log('Booking email sent to:', customerEmail);
      }
    } catch(e){ console.log('Booking email failed:',e.message); }
  }
  res.json({ok:true,appointmentId:apptId,smsSent:smsSentFlag,message:`Appointment confirmed for ${date} at ${time}`});
});

// ── Scheduler — 24hr reminders ────────────────────────────────────────────────
function scheduleReminder(appt) {
  // Stored in settings.scheduledReminders
  const reminders = db.get('settings').value().scheduledReminders||[];
  reminders.push({ apptId:appt.id, fireDate:appt.date, customerId:appt.customerId, customerName:appt.customerName, phone:appt.customerPhone, barberId:appt.barberId, barberName:appt.barberName, time:appt.time, status:'pending' });
  db.get('settings').assign({scheduledReminders:reminders.slice(-500)}).write();
}

async function runScheduler() {
  try {
    const s=db.get('settings').value()||{};
    const cfg=s.twilio||{};
    if(!cfg.accountSid||!cfg.authToken||!cfg.fromNumber) return;
    const tomorrow=new Date(Date.now()+24*3600000).toISOString().split('T')[0];
    const reminders=(s.scheduledReminders||[]).filter(r=>r.status==='pending'&&r.fireDate===tomorrow);
    const sentIds=s.remindersSent||[];
    const toSend=reminders.filter(r=>!sentIds.includes(r.apptId));
    if(!toSend.length) return;
    let twilio; try{twilio=require('twilio')(cfg.accountSid,cfg.authToken);}catch(e){return;}
    for(const r of toSend){
      if(!r.phone) continue;
      const cust=r.customerId?getById('customers',r.customerId):null;
      const phone=(cust?.phone||r.phone||'').replace(/[^0-9]/g,'');
      if(phone.length<10) continue;
      const msg=`Hi ${(r.customerName||'').split(' ')[0]||'there'}! Reminder: your appointment at ${s.shopName||'the shop'} is tomorrow at ${r.time}${r.barberName?' with '+r.barberName:''}. See you then! ✂️`;
      try{
        await twilio.messages.create({from:cfg.fromNumber,to:'+1'+phone,body:msg});
        sentIds.push(r.apptId);
        console.log('24hr reminder sent ->',r.customerName);
      }catch(e){console.error('Reminder failed:',e.message);}
    }
    db.get('settings').assign({remindersSent:sentIds.slice(-500)}).write();
  }catch(e){console.error('Scheduler error:',e.message);}
}
setInterval(runScheduler,5*60*1000);
setTimeout(runScheduler,30000);

// ── Blocked dates ─────────────────────────────────────────────────────────────
app.get('/api/blocked-dates', (req,res) => res.json(getAll('blockedDates')));
app.post('/api/blocked-dates', (req,res) => {
  const { date, reason } = req.body;
  if (!date) return res.status(400).json({ok:false,error:'Date required'});
  const existing = getAll('blockedDates').find(b=>b.date===date);
  if (existing) return res.json({ok:true,message:'Already blocked'});
  db.get('blockedDates').push({id:genId('bd'),date,reason:reason||'',createdAt:new Date().toISOString()}).write();
  res.json({ok:true});
});
app.delete('/api/blocked-dates/:date', (req,res) => {
  db.get('blockedDates').remove({date:req.params.date}).write();
  res.json({ok:true});
});

// ── Barber schedule ────────────────────────────────────────────────────────────
app.post('/api/barbers/:id/schedule', (req,res) => {
  const b = getById('barbers',req.params.id);
  if (!b) return res.status(404).json({error:'Not found'});
  b.schedule = req.body;
  upsert('barbers',b);
  res.json({ok:true});
});

// ── Serve pages ───────────────────────────────────────────────────────────────
app.get('/book',    (req,res)=>res.sendFile(path.join(CLIENT_DIR,'book.html')));
app.get('*',        (req,res)=>res.sendFile(path.join(CLIENT_DIR,'index.html')));

app.listen(PORT,()=>{
  console.log(`ShopFlow Starter running on port ${PORT}`);
  console.log(`CLIENT_DIR: ${CLIENT_DIR}`);
  console.log(`Client exists: ${fs.existsSync(CLIENT_DIR)}`);
  console.log(`index.html exists: ${fs.existsSync(path.join(CLIENT_DIR,'index.html'))}`);
});
