require('dotenv').config({ path: '../.env' });
const axios = require('axios');

async function test() {
    try {
        const instances = await axios.get('http://localhost:8080/instance/fetchInstances', {
            headers: { apikey: process.env.AUTHENTICATION_API_KEY }
        });
        
        console.log("Instances Data Type:", typeof instances.data, Array.isArray(instances.data));
        
        let instanceName = null;
        if (Array.isArray(instances.data) && instances.data.length > 0) {
            instanceName = instances.data[0].instance?.instanceName || instances.data[0].name;
        } else if (!Array.isArray(instances.data)) {
            // maybe an object
            instanceName = instances.data.value ? (instances.data.value[0]?.name || instances.data.value[0]?.instance?.instanceName) : null;
        }
        
        if (!instanceName) {
            console.log("No instance found.");
            return;
        }
        console.log("Found instance:", instanceName);
        
        // Simulate gateway code exactly
        const response = await axios.post(`http://localhost:8080/message/sendText/${instanceName}`, {
            number: "1234567890",
            options: { delay: 1200, presence: "composing" },
            textMessage: { text: "test" }
        }, { headers: { 'apikey': process.env.AUTHENTICATION_API_KEY } });
        
        console.log("Success:", response.data);
    } catch(err) {
        console.error("TEST FAILED WITH RESPONSE:", err.response?.data || err.message);
    }
}
test();
