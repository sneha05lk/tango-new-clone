const { db } = require('../config/db');

// Helper to format streams output
const formatStreams = (streams) => {
    if (!streams) return [];
    return streams.map(s => {
        const host = s.users || {};
        return {
            ...s,
            users: undefined,
            username: host.username,
            avatar: host.avatar,
            is_trending: s.viewer_count > 5 ? 1 : 0
        };
    });
};

// GET /api/streams - list all live public streams
const getStreams = async (req, res) => {
    try {
        const { data: streams, error } = await db
            .from('streams')
            .select(`
                *,
                users!host_id (username, avatar)
            `)
            .eq('is_live', true)
            .eq('type', 'public')
            .order('viewer_count', { ascending: false });

        if (error) return res.status(500).json({ message: error.message });
        res.json(formatStreams(streams));
    } catch (e) {
        res.status(500).json({ message: 'Server error' });
    }
};

// GET /api/streams/all - list all streams (incl. group/private) for authenticated users or special categories
const getAllStreams = async (req, res) => {
    const { category } = req.query;

    try {
        if (category === 'following' && req.user) {
            // First get who the user is following
            const { data: followingList } = await db
                .from('followers')
                .select('following_id')
                .eq('follower_id', req.user.id);

            const followingIds = followingList ? followingList.map(f => f.following_id) : [];

            if (followingIds.length === 0) {
                 return res.json([]);
            }

            const { data: streams, error } = await db
                .from('streams')
                .select(`
                    *,
                    users!host_id (username, avatar)
                `)
                .eq('is_live', true)
                .in('host_id', followingIds)
                .order('viewer_count', { ascending: false });

            if (error) return res.status(500).json({ message: error.message });
            res.json(formatStreams(streams));
        } else {
            const { data: streams, error } = await db
                .from('streams')
                .select(`
                    *,
                    users!host_id (username, avatar)
                `)
                .eq('is_live', true)
                .order('viewer_count', { ascending: false });

            if (error) return res.status(500).json({ message: error.message });
            res.json(formatStreams(streams));
        }
    } catch (e) {
        res.status(500).json({ message: 'Server error' });
    }
};

// GET /api/streams/search?q=query
const searchStreams = async (req, res) => {
    const query = req.query.q;
    if (!query) return res.json([]);

    try {
        // Find users that match query
        const { data: matchedUsers } = await db
             .from('users')
             .select('id')
             .ilike('username', `%${query}%`);
             
        const hostIds = matchedUsers ? matchedUsers.map(u => u.id) : [];

        // It's a bit complex to do OR on joined column natively in Supabase JS easily,
        // so we search titles OR host_id in matchedUsers
        let queryBuilder = db
            .from('streams')
            .select(`
                *,
                users!host_id (username, avatar)
            `)
            .eq('is_live', true);

        if (hostIds.length > 0) {
             queryBuilder = queryBuilder.or(`title.ilike.%${query}%,host_id.in.(${hostIds.join(',')})`);
        } else {
             queryBuilder = queryBuilder.ilike('title', `%${query}%`);
        }

        const { data: streams, error } = await queryBuilder.order('viewer_count', { ascending: false });

        if (error) return res.status(500).json({ message: error.message });
        res.json(formatStreams(streams));
    } catch (e) {
         res.status(500).json({ message: 'Server error' });
    }
};

// GET /api/streams/:id
const getStreamById = async (req, res) => {
    try {
        const { data: stream, error } = await db
            .from('streams')
            .select(`
                *,
                users!host_id (username, avatar)
            `)
            .eq('id', req.params.id)
            .single();

        if (error || !stream) return res.status(404).json({ message: 'Stream not found' });
        
        const formatted = formatStreams([stream])[0];
        res.json(formatted);
    } catch (e) {
         res.status(500).json({ message: 'Server error' });
    }
};

// POST /api/streams - create a stream
const createStream = async (req, res) => {
    const { title, category, type } = req.body;
    const roomName = `room_${Date.now()}_${req.user.id}`;
    let thumbnail = '';
    if (req.file) {
        const base64Image = req.file.buffer.toString('base64');
        thumbnail = `data:${req.file.mimetype};base64,${base64Image}`;
    }

    try {
        // Close any existing live stream by this host
        await db
            .from('streams')
            .update({ is_live: false })
            .eq('host_id', req.user.id)
            .eq('is_live', true);

        const { data: newStream, error: insertError } = await db
            .from('streams')
            .insert([{
                title: title || 'Untitled Stream',
                category: category || 'General',
                type: type || 'public',
                host_id: req.user.id,
                is_live: true,
                livekit_room: roomName,
                thumbnail: thumbnail
            }])
            .select()
            .single();

        if (insertError) return res.status(500).json({ message: insertError.message });

        const { data: streamWithUser } = await db
            .from('streams')
            .select(`
                *,
                users!host_id (username, avatar)
            `)
            .eq('id', newStream.id)
            .single();

        res.status(201).json(formatStreams([streamWithUser])[0]);
    } catch (e) {
        res.status(500).json({ message: 'Server error' });
    }
};

// PUT /api/streams/:id/end - end a stream
const endStream = async (req, res) => {
    try {
        const { data, error } = await db
            .from('streams')
            .update({ is_live: false })
            .eq('id', req.params.id)
            .eq('host_id', req.user.id)
            .select();

        if (error) return res.status(500).json({ message: error.message });
        if (!data || data.length === 0) return res.status(403).json({ message: 'Not authorized or stream not found' });
        
        res.json({ message: 'Stream ended' });
    } catch (e) {
        res.status(500).json({ message: 'Server error' });
    }
};

// POST /api/streams/:id/request - viewer requests to join private/group stream
const requestJoin = async (req, res) => {
    const { id: stream_id } = req.params;
    const user_id = req.user.id;

    try {
        const { data: existing } = await db
             .from('stream_requests')
             .select('status')
             .eq('stream_id', stream_id)
             .eq('user_id', user_id)
             .single();

        if (existing) return res.json({ message: 'Request already sent', status: existing.status });
        
        const { data: newRequest, error } = await db
            .from('stream_requests')
            .insert([{ stream_id, user_id }])
            .select('id')
            .single();

        if (error) return res.status(500).json({ message: error.message });
        res.status(201).json({ message: 'Join request sent', requestId: newRequest.id });
    } catch (e) {
         res.status(500).json({ message: 'Server error' });
    }
};

// PUT /api/streams/requests/:requestId - host approves or rejects
const handleRequest = async (req, res) => {
    const { status } = req.body; // 'approved' or 'rejected'
    try {
        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        const { data: request, error: requestError } = await db
            .from('stream_requests')
            .select('id, stream_id, status')
            .eq('id', req.params.requestId)
            .single();

        if (requestError || !request) {
            return res.status(404).json({ message: 'Request not found' });
        }

        const { data: stream, error: streamError } = await db
            .from('streams')
            .select('id')
            .eq('id', request.stream_id)
            .eq('host_id', req.user.id)
            .single();

        if (streamError || !stream) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        if (request.status && request.status !== 'pending') {
            return res.status(409).json({ message: 'Request already handled' });
        }

        const { error } = await db
            .from('stream_requests')
            .update({ status })
            .eq('id', req.params.requestId);

        if (error) return res.status(500).json({ message: error.message });
        res.json({ message: `Request ${status}` });
    } catch (e) {
        res.status(500).json({ message: 'Server error' });
    }
};

// GET /api/streams/:id/requests - get join requests for a stream (host only)
const getRequests = async (req, res) => {
    // First we check if host owns stream
    try {
         const { data: stream } = await db
            .from('streams')
            .select('id')
            .eq('id', req.params.id)
            .eq('host_id', req.user.id)
            .single();
            
        if (!stream) {
            return res.status(403).json({ message: 'Not authorized' });
        }

        const { data: requests, error } = await db
            .from('stream_requests')
            .select(`
                *,
                users!user_id (username, avatar)
            `)
            .eq('stream_id', req.params.id)
            .eq('status', 'pending');

        if (error) return res.status(500).json({ message: error.message });
        
        const formatted = requests.map(r => ({
             ...r,
             username: r.users?.username,
             avatar: r.users?.avatar,
             users: undefined
        }));

        res.json(formatted);
    } catch (e) {
        res.status(500).json({ message: 'Server error' });
    }
};

// PUT /api/streams/:id/viewers - update viewer count
const updateViewers = async (req, res) => {
    const { count } = req.body;
    try {
        const { error } = await db
            .from('streams')
            .update({ viewer_count: count })
            .eq('id', req.params.id);

        if (error) return res.status(500).json({ message: error.message });
        res.json({ message: 'Viewer count updated' });
    } catch (e) {
        res.status(500).json({ message: 'Server error' });
    }
};

module.exports = {
    getStreams,
    getAllStreams,
    getStreamById,
    createStream,
    endStream,
    requestJoin,
    handleRequest,
    getRequests,
    searchStreams,
    updateViewers
};
