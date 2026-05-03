const { db } = require('../config/db');

// GET /api/users/profile/:id
const getProfile = async (req, res) => {
    const userId = req.params.id;
    try {
        const { data: user, error: errUser } = await db
            .from('users')
            .select('id, username, avatar, bio, coin_balance, created_at')
            .eq('id', userId)
            .single();

        if (errUser || !user) return res.status(404).json({ message: 'User not found' });

        const { count: followers_count } = await db
            .from('followers')
            .select('*', { count: 'exact', head: true })
            .eq('following_id', userId);

        const { count: following_count } = await db
            .from('followers')
            .select('*', { count: 'exact', head: true })
            .eq('follower_id', userId);

        // Sum earned coins
        const { data: txs } = await db
            .from('transactions')
            .select('amount')
            .eq('receiver_id', userId)
            .eq('type', 'gift');
            
        let earned_coins = 0;
        if (txs) {
            earned_coins = txs.reduce((sum, tx) => sum + tx.amount, 0);
        }

        res.json({ ...user, followers_count: followers_count || 0, following_count: following_count || 0, earned_coins });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
};

// PUT /api/users/profile
const updateProfile = async (req, res) => {
    const { username, bio } = req.body;
    const userId = req.user.id;

    if (!username || username.trim().length < 3) {
        return res.status(400).json({ message: 'Username must be at least 3 characters' });
    }

    try {
        const { error } = await db
            .from('users')
            .update({ username: username.trim(), bio })
            .eq('id', userId);

        if (error) {
            if (error.code === '23505') { // Unique violation Postgres code
                return res.status(400).json({ message: 'Username already taken' });
            }
            return res.status(500).json({ message: error.message });
        }
        res.json({ message: 'Profile updated successfully' });
    } catch (e) {
        res.status(500).json({ message: 'Server error' });
    }
};

// POST /api/users/follow/:id
const followUser = async (req, res) => {
    const followerId = req.user.id;
    const followingId = req.params.id;

    if (followerId == followingId) {
        return res.status(400).json({ message: 'You cannot follow yourself' });
    }

    try {
        const { error } = await db
            .from('followers')
            .insert([{ follower_id: followerId, following_id: followingId }]);
            
        // Ignore duplicate insert errors (code 23505)
        if (error && error.code !== '23505') {
             return res.status(500).json({ message: error.message });
        }
        res.json({ message: 'Followed successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
};

// DELETE /api/users/follow/:id
const unfollowUser = async (req, res) => {
    const followerId = req.user.id;
    const followingId = req.params.id;

    try {
        const { error } = await db
            .from('followers')
            .delete()
            .eq('follower_id', followerId)
            .eq('following_id', followingId);

        if (error) return res.status(500).json({ message: error.message });
        res.json({ message: 'Unfollowed successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
};

// GET /api/users/follow-status/:id
const getFollowStatus = async (req, res) => {
    const followerId = req.user.id;
    const followingId = req.params.id;

    try {
        const { data, error } = await db
            .from('followers')
            .select('follower_id')
            .eq('follower_id', followerId)
            .eq('following_id', followingId)
            .limit(1)
            .single();

        if (error && error.code !== 'PGRST116') { // not found code
             return res.status(500).json({ message: error.message });
        }
        
        res.json({ isFollowing: !!data });
    } catch (e) {
        res.status(500).json({ message: 'Server error' });
    }
};

// GET /api/users/search?q=query
const searchUsers = async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);

    try {
        const { data: users, error } = await db
            .from('users')
            .select('id, username, avatar')
            .ilike('username', `%${query}%`)
            .limit(10);

        if (error) return res.status(500).json({ message: error.message });
        res.json(users);
    } catch (error) {
         res.status(500).json({ message: 'Server error' });
    }
};

// GET /api/users/:id/followers
const getFollowers = async (req, res) => {
    const userId = req.params.id;
    try {
         const { data, error } = await db
            .from('followers')
            .select(`
               users!follower_id (
                  id,
                  username,
                  avatar
               )
            `)
            .eq('following_id', userId);

        if (error) return res.status(500).json({ message: error.message });
        
        const mappedUsers = data.map(f => f.users);
        res.json(mappedUsers);
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
};

// GET /api/users/:id/following
const getFollowing = async (req, res) => {
    const userId = req.params.id;
    try {
        const { data, error } = await db
            .from('followers')
            .select(`
               users!following_id (
                  id,
                  username,
                  avatar
               )
            `)
            .eq('follower_id', userId);

        if (error) return res.status(500).json({ message: error.message });
        
        const mappedUsers = data.map(f => f.users);
        res.json(mappedUsers);
    } catch (error) {
         res.status(500).json({ message: 'Server error' });
    }
};

// POST /api/users/profile/avatar
const updateAvatar = async (req, res) => {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    
    const base64Image = req.file.buffer.toString('base64');
    const avatarPath = `data:${req.file.mimetype};base64,${base64Image}`;
    const userId = req.user.id;

    try {
        const { error } = await db
            .from('users')
            .update({ avatar: avatarPath })
            .eq('id', userId);

        if (error) return res.status(500).json({ message: error.message });
        res.json({ message: 'Avatar updated successfully', avatar: avatarPath });
    } catch (error) {
        res.status(500).json({ message: 'Server error' });
    }
};

module.exports = {
    getProfile,
    updateProfile,
    followUser,
    unfollowUser,
    getFollowStatus,
    searchUsers,
    getFollowers,
    getFollowing,
    updateAvatar
};
