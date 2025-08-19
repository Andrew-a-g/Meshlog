<?php
require_once "../../../lib/meshlog.class.php";
require_once "../../../config.php";
include "../utils.php";

$meshlog = new MeshLog(openPdo());

$results = $meshlog->getGroups(array('offset' => 0, 'count' => DEFAULT_COUNT, 'after_ms' => getParam('after_ms', 0)));

header('Content-Type: application/json; charset=utf-8');
echo json_encode($results, JSON_PRETTY_PRINT);

?>