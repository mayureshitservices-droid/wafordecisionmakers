const axios = require('axios');
require('dotenv').config({ path: '../.env' });

async function check() {
    try {
        const instanceName = 'inst_cust1_1775126043364'; // Fixed for the current test user
        const res = await axios.get(`${process.env.SERVER_URL}/instance/connectionState/${instanceName}`, {
            headers: { 'apikey': process.env.AUTHENTICATION_API_KEY }
        });
        console.log(`\n--- Instance Status for ${instanceName} ---`);
        console.log('Connection State:', res.data?.instance?.state || 'UNKNOWN');
    } catch (e) {
        console.error('Error fetching state:', e.response?.data || e.message);
    }
}
check();
