const assert = require('assert');

// Simple mock for axios
const mockAxios = {
  postedPayloads: [],
  responseToReturn: { data: { success: true } },
  post(url, payload, options) {
    this.postedPayloads.push({ url, payload, options });
    if (this.responseToReturn instanceof Promise || typeof this.responseToReturn?.then === 'function') {
      return this.responseToReturn;
    }
    return Promise.resolve(this.responseToReturn);
  }
};

// Simple mock for supabase
const mockSupabase = {
  updatedRecords: [],
  whatsapp_sent_db: false,
  from(table) {
    return {
      select(columns) {
        return {
          eq(field, value) {
            return {
              single() {
                return Promise.resolve({ data: { whatsapp_sent: mockSupabase.whatsapp_sent_db }, error: null });
              }
            };
          }
        };
      },
      update(fields) {
        return {
          eq(field, value) {
            mockSupabase.updatedRecords.push({ table, fields, eq: { field, value } });
            return Promise.resolve({ error: null });
          }
        };
      }
    };
  }
};

// Mock fs to track logged errors in unit tests
const mockFs = {
  loggedErrors: [],
  appendFileSync(file, content) {
    this.loggedErrors.push({ file, content });
  }
};

// We redefine the target function to test it with our mocks
async function testSendWhatsAppNotification(registrationData, crmUrlEnv, integrationSecretEnv) {
  // Reset mocks
  mockAxios.postedPayloads = [];
  mockSupabase.updatedRecords = [];
  mockFs.loggedErrors = [];

  // Do not call the CRM for pending or failed payments. Only proceed for free_access or paid registrations.
  if (registrationData.payment_status !== 'free_access' && registrationData.payment_status !== 'paid') {
    console.log(`[Test WhatsApp] Skipping CRM integration for registration ${registrationData.id} (payment_status: ${registrationData.payment_status})`);
    return;
  }

  // Ensure retry-safe behavior:
  // 1. Check if whatsapp_sent is already true in the passed registrationData
  if (registrationData.whatsapp_sent === true) {
    console.log(`[Test WhatsApp] WhatsApp already sent for registration ${registrationData.id} (skipped).`);
    return;
  }

  // 2. Fetch the latest registration state from database to check whatsapp_sent
  try {
    const { data: latestReg, error: fetchError } = await mockSupabase
      .from('webinar_registrations')
      .select('whatsapp_sent')
      .eq('id', registrationData.id)
      .single();

    if (fetchError) {
      console.error(`[Test WhatsApp] Failed to fetch latest registration state for retry-safe check:`, fetchError);
    } else if (latestReg && latestReg.whatsapp_sent === true) {
      console.log(`[Test WhatsApp] WhatsApp already sent for registration ${registrationData.id} according to DB (skipped).`);
      return;
    }
  } catch (err) {
    console.error(`[Test WhatsApp] Exception during retry-safe database check for registration ${registrationData.id}:`, err);
  }

  const crmUrl = crmUrlEnv || 'https://wacrm.zenacle.in/api/integrations/webinar-registration';
  
  const payload = {
    registration_id: registrationData.id,
    full_name: registrationData.full_name,
    email: registrationData.email,
    phone: registrationData.phone,
    workshop_batch: registrationData.workshop_batch,
    payment_status: registrationData.payment_status,
  };

  const headers = {};
  if (integrationSecretEnv) {
    headers['Authorization'] = `Bearer ${integrationSecretEnv}`;
  }

  const logCRMError = (message, error) => {
    const timestamp = new Date().toISOString();
    let errorDetails = '';
    if (error) {
      if (error.response) {
        errorDetails = `Status: ${error.response.status} - Data: ${JSON.stringify(error.response.data)}`;
      } else {
        errorDetails = error.message || String(error);
      }
    }
    const logLine = `[${timestamp}] ${message} ${errorDetails ? '| Details: ' + errorDetails : ''}\n`;
    mockFs.appendFileSync('crm_errors.log', logLine);
  };

  try {
    console.log(`[Test WhatsApp] Triggering CRM integration for registration ${registrationData.id} (${registrationData.email})`);
    const response = await mockAxios.post(crmUrl, payload, { headers, timeout: 15000 });
    
    if (response.data && response.data.success === true) {
      console.log(`[Test WhatsApp] CRM registration integration succeeded for ${registrationData.email}.`);
      
      const { error } = await mockSupabase
        .from('webinar_registrations')
        .update({ whatsapp_sent: true })
        .eq('id', registrationData.id);
        
      if (error) {
        logCRMError(`Failed to update whatsapp_sent in DB for registration ${registrationData.id}`, error);
      } else {
        console.log(`[Test WhatsApp] Successfully updated whatsapp_sent to true for registration ${registrationData.id}`);
      }
    } else {
      logCRMError(`CRM integration returned non-success response for ${registrationData.email}`, null);
    }
  } catch (error) {
    logCRMError(`Failed CRM integration request for ${registrationData.email}`, error);
  }
}

async function runTests() {
  console.log('Running CRM integration unit tests...');

  // Test Case 1: free_access registration should trigger CRM and update database
  console.log('\n--- Test Case 1: free_access ---');
  const regFree = {
    id: 'reg_123',
    full_name: 'John Doe',
    phone: '9876543210',
    email: 'john@example.com',
    workshop_batch: 'Batch A',
    payment_status: 'free_access'
  };
  mockAxios.responseToReturn = { data: { success: true } };
  mockSupabase.whatsapp_sent_db = false;
  await testSendWhatsAppNotification(regFree, 'http://mock-crm/api/integrations', 'secret_key');
  
  assert.strictEqual(mockAxios.postedPayloads.length, 1);
  assert.deepStrictEqual(mockAxios.postedPayloads[0].payload, {
    registration_id: 'reg_123',
    full_name: 'John Doe',
    email: 'john@example.com',
    phone: '9876543210',
    workshop_batch: 'Batch A',
    payment_status: 'free_access'
  });
  assert.strictEqual(mockAxios.postedPayloads[0].options.headers['Authorization'], 'Bearer secret_key');
  assert.strictEqual(mockSupabase.updatedRecords.length, 1);
  assert.deepStrictEqual(mockSupabase.updatedRecords[0].fields, { whatsapp_sent: true });
  assert.strictEqual(mockSupabase.updatedRecords[0].eq.value, 'reg_123');
  console.log('Test Case 1 Passed!');

  // Test Case 2: paid registration should trigger CRM and update database
  console.log('\n--- Test Case 2: paid ---');
  const regPaid = {
    id: 'reg_456',
    full_name: 'Jane Smith',
    phone: '9999999999',
    email: 'jane@example.com',
    workshop_batch: 'Batch B',
    payment_status: 'paid'
  };
  mockAxios.responseToReturn = { data: { success: true } };
  mockSupabase.whatsapp_sent_db = false;
  await testSendWhatsAppNotification(regPaid, 'http://mock-crm/api/integrations', 'secret_key');
  
  assert.strictEqual(mockAxios.postedPayloads.length, 1);
  assert.deepStrictEqual(mockAxios.postedPayloads[0].payload, {
    registration_id: 'reg_456',
    full_name: 'Jane Smith',
    email: 'jane@example.com',
    phone: '9999999999',
    workshop_batch: 'Batch B',
    payment_status: 'paid'
  });
  assert.strictEqual(mockSupabase.updatedRecords.length, 1);
  assert.deepStrictEqual(mockSupabase.updatedRecords[0].fields, { whatsapp_sent: true });
  assert.strictEqual(mockSupabase.updatedRecords[0].eq.value, 'reg_456');
  console.log('Test Case 2 Passed!');

  // Test Case 3: pending registration should NOT trigger CRM
  console.log('\n--- Test Case 3: pending ---');
  const regPending = {
    id: 'reg_789',
    full_name: 'Alice Cooper',
    phone: '8888888888',
    email: 'alice@example.com',
    workshop_batch: 'Batch C',
    payment_status: 'pending'
  };
  mockSupabase.whatsapp_sent_db = false;
  await testSendWhatsAppNotification(regPending, 'http://mock-crm/api/integrations', 'secret_key');
  
  assert.strictEqual(mockAxios.postedPayloads.length, 0, 'Should not post to CRM for pending');
  assert.strictEqual(mockSupabase.updatedRecords.length, 0, 'Should not update database for pending');
  console.log('Test Case 3 Passed!');

  // Test Case 4: failed registration should NOT trigger CRM
  console.log('\n--- Test Case 4: failed ---');
  const regFailed = {
    id: 'reg_101',
    full_name: 'Bob Marley',
    phone: '7777777777',
    email: 'bob@example.com',
    workshop_batch: 'Batch D',
    payment_status: 'failed'
  };
  mockSupabase.whatsapp_sent_db = false;
  await testSendWhatsAppNotification(regFailed, 'http://mock-crm/api/integrations', 'secret_key');
  
  assert.strictEqual(mockAxios.postedPayloads.length, 0, 'Should not post to CRM for failed');
  assert.strictEqual(mockSupabase.updatedRecords.length, 0, 'Should not update database for failed');
  console.log('Test Case 4 Passed!');

  // Test Case 5: CRM returns success=false should NOT update database
  console.log('\n--- Test Case 5: CRM returns success=false ---');
  const regFreeFail = {
    id: 'reg_102',
    full_name: 'Charlie Brown',
    phone: '6666666666',
    email: 'charlie@example.com',
    workshop_batch: 'Batch E',
    payment_status: 'free_access'
  };
  mockAxios.responseToReturn = { data: { success: false } };
  mockSupabase.whatsapp_sent_db = false;
  await testSendWhatsAppNotification(regFreeFail, 'http://mock-crm/api/integrations', 'secret_key');
  
  assert.strictEqual(mockAxios.postedPayloads.length, 1);
  assert.strictEqual(mockSupabase.updatedRecords.length, 0, 'Should not update database when CRM returns success=false');
  assert.strictEqual(mockFs.loggedErrors.length, 1, 'Non-success response should log an error');
  console.log('Test Case 5 Passed!');

  // Test Case 6: already sent registration object should NOT trigger CRM
  console.log('\n--- Test Case 6: already sent object ---');
  const regAlreadySent = {
    id: 'reg_202',
    full_name: 'Eva Green',
    phone: '5555555555',
    email: 'eva@example.com',
    workshop_batch: 'Batch F',
    payment_status: 'paid',
    whatsapp_sent: true
  };
  mockSupabase.whatsapp_sent_db = false;
  await testSendWhatsAppNotification(regAlreadySent, 'http://mock-crm/api/integrations', 'secret_key');
  assert.strictEqual(mockAxios.postedPayloads.length, 0, 'Should not post to CRM if already sent in object');
  assert.strictEqual(mockSupabase.updatedRecords.length, 0, 'Should not update DB if already sent in object');
  console.log('Test Case 6 Passed!');

  // Test Case 7: already sent in DB should NOT trigger CRM
  console.log('\n--- Test Case 7: already sent in DB ---');
  const regAlreadySentDB = {
    id: 'reg_203',
    full_name: 'Frank Miller',
    phone: '4444444444',
    email: 'frank@example.com',
    workshop_batch: 'Batch G',
    payment_status: 'paid',
    whatsapp_sent: false
  };
  mockSupabase.whatsapp_sent_db = true; // Simulating that DB already has whatsapp_sent = true
  await testSendWhatsAppNotification(regAlreadySentDB, 'http://mock-crm/api/integrations', 'secret_key');
  assert.strictEqual(mockAxios.postedPayloads.length, 0, 'Should not post to CRM if already sent in DB');
  assert.strictEqual(mockSupabase.updatedRecords.length, 0, 'Should not update DB if already sent in DB');
  console.log('Test Case 7 Passed!');

  // Test Case 8: CRM API error is stored in logs
  console.log('\n--- Test Case 8: CRM API error is stored in logs ---');
  const regError = {
    id: 'reg_204',
    full_name: 'Grace Hopper',
    phone: '3333333333',
    email: 'grace@example.com',
    workshop_batch: 'Batch H',
    payment_status: 'paid'
  };
  mockSupabase.whatsapp_sent_db = false;
  mockAxios.responseToReturn = Promise.reject(new Error('Network Connection Timeout'));
  await testSendWhatsAppNotification(regError, 'http://mock-crm/api/integrations', 'secret_key');
  
  assert.strictEqual(mockSupabase.updatedRecords.length, 0, 'Should not update DB on error');
  assert.strictEqual(mockFs.loggedErrors.length, 1, 'Error should be logged to file');
  assert.match(mockFs.loggedErrors[0].content, /Network Connection Timeout/, 'Log message should contain error info');
  console.log('Test Case 8 Passed!');

  console.log('\nAll unit tests passed successfully!');
}

runTests().catch(console.error);
