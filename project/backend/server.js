require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const Razorpay = require('razorpay');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const csv = require('csv-parser');
const { Readable } = require('stream');

const app = express();
app.use(cors());
app.use(express.json());

// ------------------------------------------------------------------
// Serve frontend files (index.html, CSS, JS, images) from project root
// ------------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', '..')));

// ------------------------------------------------------------------
// Environment & service clients
// ------------------------------------------------------------------
const {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PORT = 5000,
} = process.env;

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Missing required environment variables.');
  process.exit(1);
}

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DEFAULT_PRICE = 999; // INR

const PROMO_DEFINITIONS = {
  ZEN70: { discountPercent: 70, type: 'single' },
  ZEN100: { discountPercent: 100, type: 'single' },
  MATT100: { discountPercent: 100, type: 'limited', limit: 3 },
  MET100: { discountPercent: 100, type: 'limited', limit: 3 },
};

// ------------------------------------------------------------------
// Helper: Fetch Google Sheets survey responses and check completion
// ------------------------------------------------------------------
async function checkSurveyCompletion(email, phone) {
  try {
    const csvUrl = 'https://docs.google.com/spreadsheets/d/12vwgutblI-2qSx1NBfEWgGUhGNpWKiDVcizp9iG2VlU/export?format=csv';
    const response = await axios.get(csvUrl, {
      responseType: 'text',
      timeout: 10000
    });

    return new Promise((resolve, reject) => {
      const results = [];
      const stream = Readable.from(response.data);

      stream.pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', () => {
          const targetEmail = (email || '').trim().toLowerCase();
          const cleanRegPhone = (phone || '').replace(/\D/g, '');
          const targetPhoneSuffix = cleanRegPhone.length >= 10 ? cleanRegPhone.slice(-10) : cleanRegPhone;

          const match = results.some(row => {
            const emailKey = Object.keys(row).find(k => k.toLowerCase().includes('email') || k.toLowerCase().includes('mail'));
            const phoneKey = Object.keys(row).find(k => k.toLowerCase().includes('whatsapp') || k.toLowerCase().includes('phone') || k.toLowerCase().includes('contact') || k.toLowerCase().includes('number'));

            let emailMatch = false;
            let phoneMatch = false;

            if (emailKey && targetEmail) {
              const sheetEmail = (row[emailKey] || '').trim().toLowerCase();
              emailMatch = (sheetEmail === targetEmail);
            }

            if (phoneKey && targetPhoneSuffix) {
              const sheetPhoneRaw = (row[phoneKey] || '');
              const cleanSheetPhone = sheetPhoneRaw.replace(/\D/g, '');
              const sheetPhoneSuffix = cleanSheetPhone.length >= 10 ? cleanSheetPhone.slice(-10) : cleanSheetPhone;
              phoneMatch = (sheetPhoneSuffix && sheetPhoneSuffix === targetPhoneSuffix);
            }

            return emailMatch || phoneMatch;
          });

          resolve(match);
        })
        .on('error', (err) => {
          reject(err);
        });
    });
  } catch (error) {
    console.error('Error fetching or parsing survey sheet:', error);
    throw error;
  }
}

// ------------------------------------------------------------------
// Helper: Promo validation (server‑side)
// ------------------------------------------------------------------
async function validatePromo(promoCode, email, phone) {
  const code = (promoCode || '').trim().toUpperCase();
  if (!code) {
    return {
      valid: true,
      finalAmount: DEFAULT_PRICE,
      discountPercentage: 0,
      couponType: 'none',
      message: 'No promo code applied.',
    };
  }
  const promo = PROMO_DEFINITIONS[code];
  if (!promo) {
    return { valid: false, message: 'Invalid promo code.' };
  }

  // Custom check for ZEN70 (Google Sheet Survey Completion verification)
  if (code === 'ZEN70') {
    try {
      const isCompleted = await checkSurveyCompletion(email, phone);
      if (!isCompleted) {
        return {
          valid: false,
          message: 'Please complete the career survey to unlock this scholarship.'
        };
      }
    } catch (err) {
      console.error('ZEN70 validation error:', err);
      return {
        valid: false,
        message: 'Could not verify survey completion. Please try again later.'
      };
    }
  }
  // Limited‑use check
  if (promo.type === 'limited') {
    const { data, error } = await supabase
      .from('webinar_registrations')
      .select('id', { count: 'exact', head: true })
      .eq('promo_code', code);
    if (error) {
      console.error('Supabase usage count error:', error);
      return { valid: false, message: 'Server error validating promo.' };
    }
    const used = data?.length ?? 0;
    if (used >= promo.limit) {
      return {
        valid: false,
        message: 'This invite code has reached its usage limit.',
      };
    }
  }
  const discount = Math.round((DEFAULT_PRICE * promo.discountPercent) / 100);
  const finalAmount = Math.max(0, DEFAULT_PRICE - discount);
  return {
    valid: true,
    finalAmount,
    discountPercentage: promo.discountPercent,
    couponType: code,
    message: `Promo applied – ${promo.discountPercent}% off.`,
  };
}

// ------------------------------------------------------------------
// Helper: Duplicate registration check
// ------------------------------------------------------------------
async function isDuplicate(email, phone) {
  const { data, error } = await supabase
    .from('webinar_registrations')
    .select('id')
    .eq('email', email)
    .eq('phone', phone)
    .single();
  if (error && error.code !== 'PGRST116') {
    console.error('Supabase duplicate check error:', error);
    throw new Error('Database error');
  }
  return !!data;
}

// ------------------------------------------------------------------
// API: Validate promo code
// ------------------------------------------------------------------
app.post('/validate-promo', async (req, res) => {
  const { promoCode, email, phone } = req.body;
  try {
    const result = await validatePromo(promoCode, email, phone);
    if (!result.valid) {
      return res.status(400).json({ success: false, message: result.message });
    }
    res.json({
      success: true,
      finalAmount: result.finalAmount,
      discountPercentage: result.discountPercentage,
      couponType: result.couponType,
      message: result.message,
    });
  } catch (err) {
    console.error('Validate promo error:', err);
    res.status(500).json({ success: false, message: 'Server error.' });
  }
});

// ------------------------------------------------------------------
// API: Create Razorpay order (secure)
// ------------------------------------------------------------------
app.post('/create-order', async (req, res) => {
  const { promoCode, leadData } = req.body; // leadData contains all form fields
  try {
    // Re‑validate promo on server to avoid tampering
    const promoResult = await validatePromo(promoCode, leadData.email, leadData.phone);
    if (!promoResult.valid) {
      return res.status(400).json({ success: false, message: promoResult.message });
    }
    const amount = promoResult.finalAmount * 100; // paise
    const options = {
      amount,
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
      notes: {
        workshop: 'What Nobody Tells Fresh Engineers',
        email: leadData.email,
        phone: leadData.phone,
        promo_code: promoResult.couponType || '',
      },
    };
    const order = await razorpay.orders.create(options);
    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error('Create order error:', err);
    res.status(500).json({ success: false, message: 'Failed to create order.' });
  }
});

// ------------------------------------------------------------------
// API: Verify payment signature & store registration
// ------------------------------------------------------------------
app.post('/verify-payment', async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    leadData,
    promoData,
  } = req.body;

  // free‑access shortcut – if final amount is zero
  if (promoData && promoData.finalAmount === 0) {
    try {
      if (await isDuplicate(leadData.email, leadData.phone)) {
        return res.status(409).json({ success: false, message: 'You have already registered.' });
      }
      const insertPayload = {
        full_name: leadData.fullName,
        email: leadData.email,
        phone: leadData.phone,
        city: leadData.city,
        engineering_background: leadData.background,
        workshop_batch: leadData.session,
        promo_code: promoData.couponType || null,
        coupon_type: promoData.couponType || null,
        original_amount: DEFAULT_PRICE,
        final_amount: 0,
        discount_percentage: promoData.discountPercentage || 0,
        payment_status: 'free_access',
        payment_method: 'free',
        razorpay_payment_id: `FREE_${Date.now()}`,
        razorpay_order_id: null,
        razorpay_signature: null,
        registration_source: 'webinar-landing',
      };
      const { error } = await supabase.from('webinar_registrations').insert([insertPayload]);
      if (error) throw error;
      return res.json({ success: true, message: 'Registration saved (free access).', paymentId: insertPayload.razorpay_payment_id });
    } catch (e) {
      console.error('Free registration error:', e);
      return res.status(500).json({ success: false, message: 'Failed to save registration.' });
    }
  }

  // ------------------------------------------------------------
  // 1️⃣ Verify Razorpay signature
  // ------------------------------------------------------------
  const generatedSignature = crypto
    .createHmac('sha256', RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (generatedSignature !== razorpay_signature) {
    return res.status(400).json({ success: false, message: 'Invalid payment signature.' });
  }

  // ------------------------------------------------------------
  // 2️⃣ Duplicate registration check
  // ------------------------------------------------------------
  try {
    if (await isDuplicate(leadData.email, leadData.phone)) {
      return res.status(409).json({ success: false, message: 'You have already registered.' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Database error.' });
  }

  // ------------------------------------------------------------
  // 3️⃣ Persist registration
  // ------------------------------------------------------------
  const insertPayload = {
    full_name: leadData.fullName,
    email: leadData.email,
    phone: leadData.phone,
    city: leadData.city,
    engineering_background: leadData.background,
    workshop_batch: leadData.session,
    promo_code: promoData.couponType || null,
    coupon_type: promoData.couponType || null,
    original_amount: DEFAULT_PRICE,
    final_amount: promoData.finalAmount,
    discount_percentage: promoData.discountPercentage,
    payment_status: 'paid',
    payment_method: 'razorpay',
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature,
    registration_source: 'webinar-landing',
  };

  const { error } = await supabase.from('webinar_registrations').insert([insertPayload]);
  if (error) {
    console.error('Supabase insert error:', error);
    return res.status(500).json({ success: false, message: 'Failed to save registration.' });
  }

  res.json({
    success: true,
    message: 'Registration saved.',
    paymentId: razorpay_payment_id,
    amountPaid: promoData.finalAmount,
  });
});

// ------------------------------------------------------------------
// Health check (API only — frontend is served via static middleware)
// ------------------------------------------------------------------
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend Running Successfully' });
});

// ------------------------------------------------------------------
// Start server
// ------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});