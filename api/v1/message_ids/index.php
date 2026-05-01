<?php
$start = microtime(true);
require_once "../../../lib/meshlog.class.php";
require_once "../../../config.php";
include "../utils.php";

$meshlog = new MeshLog($config['db']);
$err = $meshlog->getError();

if ($err) {
    $results = array('error' => $err);
} else {
    $results = $meshlog->getRecentMessageIds(array(
        'count' => getParam('count', DEFAULT_COUNT),
        'after_ms' => getParam('after_ms', 0),
        'before_ms' => getParam('before_ms', 0),
        'include_advertisements' => getParam('include_advertisements', 1),
        'include_channel_messages' => getParam('include_channel_messages', 1),
        'include_direct_messages' => getParam('include_direct_messages', 1),
    ));
}

$results['time'] = microtime(true) - $start;

header('Content-Type: application/json; charset=utf-8');
echo json_encode($results);

?>
