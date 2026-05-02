const express = require('express');
const router = express.Router();
const {
    getStreams, getAllStreams, getStreamById, createStream, endStream,
    requestJoin, handleRequest, getRequests, searchStreams, updateViewers
} = require('../controllers/streamController');
const { protect } = require('../middlewares/auth');
const upload = require('../middlewares/upload');

router.get('/', getStreams);                             // public streams (no auth)
router.get('/all', protect, getAllStreams);              // all streams (authenticated)
router.get('/search', searchStreams);                    // search streams
router.get('/:id', getStreamById);
router.post('/', protect, upload.single('thumbnail'), createStream);
router.put('/:id/end', protect, endStream);
router.post('/:id/request', protect, requestJoin);
router.put('/requests/:requestId', protect, handleRequest);
router.get('/:id/requests', protect, getRequests);
router.put('/:id/viewers', updateViewers);

module.exports = router;
