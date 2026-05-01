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
    $results = $meshlog->getContactsQuick(array(
        'offset' => 0, 
        'count' => DEFAULT_CONTACTS_COUNT,
        'after_ms' => getParam('after_ms', 0),
        'before_ms' => getParam('before_ms', 0),
    ));
    limitContactAdvertisementReportsPerReporter($results['objects'], $reportLimit);
}
header('Content-Type: application/json; charset=utf-8');
echo json_encode($results);

?>
