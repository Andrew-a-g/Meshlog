<?php

class Migration_010 extends Migration {
    public function __construct() {
        parent::__construct(9, 10);
    }

    private function indexExists($pdo, $table, $indexName) {
        $stmt = $pdo->prepare("
            SELECT COUNT(*) AS total
            FROM information_schema.statistics
            WHERE table_schema = DATABASE()
                AND table_name = :table
                AND index_name = :index_name
        ");
        $stmt->execute(array(
            'table' => $table,
            'index_name' => $indexName,
        ));

        return intval($stmt->fetchColumn()) > 0;
    }

    private function addIndexIfMissing($pdo, $table, $indexName, $definition) {
        if ($this->indexExists($pdo, $table, $indexName)) {
            return;
        }

        $pdo->exec("ALTER TABLE `$table` ADD INDEX `$indexName` $definition");
    }

    function migrate($pdo) {
        $this->addIndexIfMissing($pdo, 'contacts', 'last_heard_at_id', '(`last_heard_at`, `id`)');
        $this->addIndexIfMissing($pdo, 'advertisements', 'contact_id_id', '(`contact_id`, `id`)');
        $this->addIndexIfMissing($pdo, 'telemetry', 'contact_id_id', '(`contact_id`, `id`)');
        $this->addIndexIfMissing($pdo, 'advertisement_reports', 'advertisement_id_reporter_id', '(`advertisement_id`, `reporter_id`)');

        return array(
            'success' => true,
            'message' => ''
        );
    }
}

?>
