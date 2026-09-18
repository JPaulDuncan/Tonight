using System;
using Tonight.Core;
using UnityEngine;

namespace Tonight.Net
{
    /// <summary>
    /// One build piece on the wire: exactly 9 bytes.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Build pieces do not replicate as NetworkObjects (ADR-0002). They never
    /// move, they are fully described by an integer cell, and a late-game fight
    /// produces thousands of them -- replicating transforms would blow the
    /// entire per-client bandwidth budget on its own.
    /// </para>
    /// <para>
    /// The layout packs to 9 bytes rather than the naive 10:
    /// </para>
    /// <code>
    ///   byte 0-1  cellX   int16
    ///   byte 2-3  cellY   int16
    ///   byte 4-5  cellZ   int16
    ///   byte 6    slot    3 bits  |  hpBucket  4 bits  (1 bit spare)
    ///   byte 7    pieceId   uint8
    ///   byte 8    materialId uint8
    /// </code>
    /// <para>
    /// Slot has six values and health is quantised to sixteen levels, so both
    /// fit in one byte together. At 60 placements per second that packing is
    /// worth roughly 500 bytes/s per client against the 128 kbit/s budget --
    /// small, but it is the difference between meeting the documented budget
    /// and exceeding it.
    /// </para>
    /// <para>
    /// Quantising health is the larger win: ordinary chip damage no longer
    /// generates an update per hit.
    /// </para>
    /// </remarks>
    public readonly struct StructureRecord : IEquatable<StructureRecord>
    {
        /// <summary>Serialised size. Asserted by tests, not merely intended.</summary>
        public const int SizeBytes = 9;

        /// <summary>Health is quantised to this many levels.</summary>
        public const int HealthBuckets = 16;

        private const int SlotBits = 3;
        private const int SlotMask = (1 << SlotBits) - 1;
        private const int HealthMask = (1 << 4) - 1;

        public readonly GridCell Cell;
        public readonly BuildSlot Slot;
        public readonly byte PieceId;
        public readonly byte MaterialId;
        public readonly byte HealthBucket;

        public StructureRecord(
            GridCell cell, BuildSlot slot, byte pieceId, byte materialId, byte healthBucket)
        {
            Cell = cell;
            Slot = slot;
            PieceId = pieceId;
            MaterialId = materialId;
            HealthBucket = (byte)Mathf.Clamp(healthBucket, 0, HealthBuckets - 1);
        }

        /// <summary>
        /// Quantise a health fraction to a bucket.
        /// </summary>
        /// <remarks>
        /// A living piece never quantises to bucket 0: a wall on 1% health is
        /// still cover, and showing it as destroyed would be worse than showing
        /// it as slightly damaged.
        /// </remarks>
        public static byte QuantiseHealth(float current, float max)
        {
            if (max <= 0f || current <= 0f)
            {
                return 0;
            }

            float fraction = Mathf.Clamp01(current / max);
            int bucket = Mathf.CeilToInt(fraction * (HealthBuckets - 1));
            return (byte)Mathf.Clamp(bucket, 1, HealthBuckets - 1);
        }

        /// <summary>Approximate health a bucket represents, for client display.</summary>
        public static float DequantiseHealth(byte bucket, float max) =>
            max * (Mathf.Clamp(bucket, 0, HealthBuckets - 1) / (float)(HealthBuckets - 1));

        public void Write(Span<byte> destination)
        {
            if (destination.Length < SizeBytes)
            {
                throw new ArgumentException(
                    $"Need {SizeBytes} bytes, got {destination.Length}.", nameof(destination));
            }

            WriteInt16(destination, 0, (short)Cell.X);
            WriteInt16(destination, 2, (short)Cell.Y);
            WriteInt16(destination, 4, (short)Cell.Z);

            destination[6] = (byte)(((int)Slot & SlotMask) | ((HealthBucket & HealthMask) << SlotBits));
            destination[7] = PieceId;
            destination[8] = MaterialId;
        }

        public static StructureRecord Read(ReadOnlySpan<byte> source)
        {
            if (source.Length < SizeBytes)
            {
                throw new ArgumentException(
                    $"Need {SizeBytes} bytes, got {source.Length}.", nameof(source));
            }

            var cell = new GridCell(
                ReadInt16(source, 0), ReadInt16(source, 2), ReadInt16(source, 4));

            byte packed = source[6];
            var slot = (BuildSlot)(packed & SlotMask);
            var health = (byte)((packed >> SlotBits) & HealthMask);

            return new StructureRecord(cell, slot, source[7], source[8], health);
        }

        // Little-endian by hand rather than BitConverter, which is
        // host-endian and would silently disagree between a big-endian server
        // and a little-endian client.
        private static void WriteInt16(Span<byte> buffer, int offset, short value)
        {
            buffer[offset] = (byte)(value & 0xFF);
            buffer[offset + 1] = (byte)((value >> 8) & 0xFF);
        }

        private static short ReadInt16(ReadOnlySpan<byte> buffer, int offset) =>
            (short)(buffer[offset] | (buffer[offset + 1] << 8));

        public bool Equals(StructureRecord other) =>
            Cell == other.Cell &&
            Slot == other.Slot &&
            PieceId == other.PieceId &&
            MaterialId == other.MaterialId &&
            HealthBucket == other.HealthBucket;

        public override bool Equals(object obj) => obj is StructureRecord other && Equals(other);

        public override int GetHashCode()
        {
            unchecked
            {
                int hash = Cell.GetHashCode();
                hash = (hash * 397) ^ (int)Slot;
                hash = (hash * 397) ^ PieceId;
                hash = (hash * 397) ^ MaterialId;
                hash = (hash * 397) ^ HealthBucket;
                return hash;
            }
        }

        public override string ToString() =>
            $"{Cell}/{Slot} piece={PieceId} mat={MaterialId} hp={HealthBucket}/{HealthBuckets - 1}";
    }
}
