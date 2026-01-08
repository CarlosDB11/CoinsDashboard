// Railway-specific configuration
module.exports = {
    telegram: {
        connectionRetries: 10,
        retryDelay: 2000,
        timeout: 15000,
        useWSS: true, // Try WebSocket Secure
        floodSleepThreshold: 60
    },
    bot: {
        polling: {
            interval: 1000,
            autoStart: true,
            params: {
                timeout: 10
            }
        }
    }
};