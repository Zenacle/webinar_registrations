require('dotenv').config();
const axios = require('axios');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

async function getSchema() {
  const url = `${SUPABASE_URL}/rest/v1/`;
  const response = await axios.get(url, {
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
    }
  });

  const tableDef = response.data.definitions.webinar_registrations;
  if (tableDef) {
    console.log('webinar_registrations columns:');
    console.log(JSON.stringify(tableDef.properties, null, 2));
  } else {
    console.log('Could not find definition for webinar_registrations. Available tables:', Object.keys(response.data.definitions));
  }
}

getSchema().catch(console.error);
