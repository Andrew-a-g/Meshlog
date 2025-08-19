<?php

class MeshLogReporter extends MeshLogEntity {
    protected static $table = "reporters";

    public $name = null;
    public $authorized = null;
    public $public_key = null;
    public $lat = null;
    public $lon = null;
    public $color = null;

    public static function fromDb($data, $meshlog) {
        if (!$data) return null;

        $m = new MeshLogReporter($meshlog);

        $m->_id = $data['id'];
        $m->name = $data['name'];
        $m->authorized = $data['authorized'];
        $m->public_key = $data['public_key'];
        $m->lat = $data['lat'];
        $m->lon = $data['lon'];
        $m->color = $data['color'];

        return $m;
    }

    public function asArray() {
        return array(
            'id' => $this->getId(),
            'name' => $this->name,
            'public_key' => $this->public_key,
            'lat' => $this->lat,
            'lon' => $this->lon,
            'color' => $this->color
        );
    }

    public function updateLocation($meshlog, $lat, $lon) {
        if (!$lat || !$lon) return;
        if ($lat == $this->lat && $lon == $this->lon) return;

        $tableStr = static::$table;
        $query = $meshlog->pdo->prepare("UPDATE $tableStr SET lat = :lat, lon = :lon WHERE id = :id");

        $query->bindParam(':lat', $lat,  PDO::PARAM_STR);
        $query->bindParam(':lon', $lon,  PDO::PARAM_STR);
        $query->bindParam(':id', $this->_id,  PDO::PARAM_INT);
        $query->execute();
    }

    public function isValid() {
        return false; // can't save
    }
}

?>