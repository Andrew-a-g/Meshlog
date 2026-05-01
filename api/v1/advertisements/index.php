<?php
$start = microtime(true);
require_once "../../../lib/meshlog.class.php";
require_once "../../../config.php";
include "../utils.php";

$meshlog = new MeshLog($config['db']);
$err = $meshlog->getError();
$reportLimit = getReportLimitParam(1);

if ($err) {
    $results = array('error' => $err);
} else {
    $results = $meshlog->getAdvertisementsQuick(array(
        'offset' => getParam('offset', 0),
        'count' => getParam('count', DEFAULT_COUNT),
        'ids' => getParam('ids', array()),
        'after_ms' => getParam('after_ms', 0),
        'before_ms' => getParam('before_ms', 0),
    ), true);
    limitObjectReportsPerReporter($results['objects'], $reportLimit);
}

$results['time'] = microtime(true) - $start;

header('Content-Type: application/json; charset=utf-8');
echo json_encode($results);

?>
