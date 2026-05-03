const jwt = require('jsonwebtoken');
const { db } = require('../config/db');
const bcrypt = require('bcryptjs');
const { getRequiredEnv } = require('../config/security');

const generateToken = (id) =>
    jwt.sign({ id }, getRequiredEnv('JWT_SECRET'), { expiresIn: '30d' });

// POST /api/auth/register
const register = async (req, res) => {
    let { username, email, password } = req.body;
    if (!username || !email || !password)
        return res.status(400).json({ message: 'All fields are required' });

    username = username.trim();
    email = email.trim().toLowerCase();

    try {
        const { data: existing, error: errExisting } = await db
            .from('users')
            .select('id')
            .or(`email.eq.${email},username.eq.${username}`)
            .limit(1)
            .single();

        if (existing) return res.status(400).json({ message: 'Username or email already taken' });
        
        const hash = await bcrypt.hash(password, 10);
        
        const { data: newUser, error: insertError } = await db
            .from('users')
            .insert([{ username, email, password: hash }])
            .select('id, username, email, coin_balance, role')
            .single();

        if (insertError) return res.status(500).json({ message: insertError.message });

        const token = generateToken(newUser.id);
        res.status(201).json({
            id: newUser.id, username: newUser.username, email: newUser.email,
            coin_balance: newUser.coin_balance, role: newUser.role, token
        });
    } catch (error) {
        res.status(500).json({ message: 'Server error: ' + error.message });
    }
};

// POST /api/auth/login
const login = async (req, res) => {
    let { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ message: 'All fields are required' });
        
    email = email.trim().toLowerCase();
    
    try {
        const { data: user, error: errUser } = await db
            .from('users')
            .select('*')
            .eq('email', email)
            .limit(1)
            .single();

        if (errUser || !user) return res.status(401).json({ message: 'Invalid email or password' });
        
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ message: 'Invalid email or password' });

        const token = generateToken(user.id);
        res.json({
            id: user.id, username: user.username, email: user.email,
            coin_balance: user.coin_balance, role: user.role,
            avatar: user.avatar, token
        });
    } catch (error) {
         res.status(500).json({ message: 'Server error: ' + error.message });
    }
};

// GET /api/auth/me
const getMe = async (req, res) => {
    try {
        const { data: user, error } = await db
            .from('users')
            .select('id, username, email, coin_balance, role, avatar, created_at')
            .eq('id', req.user.id)
            .limit(1)
            .single();

        if (error || !user) return res.status(404).json({ message: 'User not found' });

        // Get stream count
        const { count: total_streams } = await db
            .from('streams')
            .select('*', { count: 'exact', head: true })
            .eq('host_id', req.user.id);
            
        // Get followers count
        const { count: followers } = await db
            .from('followers')
            .select('*', { count: 'exact', head: true })
            .eq('following_id', req.user.id);

        res.json({ ...user, total_streams, followers });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
};

module.exports = { register, login, getMe };
