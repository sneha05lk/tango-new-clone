const { createClient } = require('@supabase/supabase-js');
const bcrypt = require('bcryptjs');
const { getRequiredEnv } = require('./security');

const supabaseUrl = getRequiredEnv('SUPABASE_URL');
const supabaseKey = getRequiredEnv('SUPABASE_KEY');

const supabase = createClient(supabaseUrl, supabaseKey);

const initDB = async () => {
    console.log('Supabase initialized.');
    
    try {
        const seedEnabled = process.env.ENABLE_ADMIN_SEED === 'true';
        if (!seedEnabled) {
            return;
        }

        const adminEmail = getRequiredEnv('ADMIN_SEED_EMAIL').toLowerCase();
        const adminUsername = process.env.ADMIN_SEED_USERNAME?.trim() || 'admin';
        const adminPassword = getRequiredEnv('ADMIN_SEED_PASSWORD');

        // Seed admin user if not exists (explicitly opt-in only)
        const { data: existingAdmin } = await supabase
            .from('users')
            .select('id')
            .eq('email', adminEmail)
            .limit(1)
            .single();

        if (!existingAdmin) {
            const hash = await bcrypt.hash(adminPassword, 10);
            const { error: insertError } = await supabase
                .from('users')
                .insert([{
                    username: adminUsername,
                    email: adminEmail,
                    password: hash,
                    coin_balance: 9999999,
                    role: 'admin'
                }]);
            
            if (!insertError) {
                console.log(`Admin seed user created: ${adminEmail}`);
            } else {
                console.error("Failed to seed admin:", insertError.message);
            }
        }
    } catch (e) {
        console.error("Error connecting to Supabase during init:", e.message);
    }
};

module.exports = { db: supabase, initDB };
