using System;
using UnityEngine;

namespace Tonight.Core
{
    /// <summary>An inclusive integer range, serialisable in the Inspector.</summary>
    [Serializable]
    public struct IntRange
    {
        [SerializeField] private int _min;
        [SerializeField] private int _max;

        public IntRange(int min, int max)
        {
            _min = min;
            _max = max;
        }

        public int Min => _min;

        public int Max => _max;

        public bool IsValid => _max >= _min;

        public static IntRange Single(int value) => new IntRange(value, value);

        public override string ToString() => _min == _max ? _min.ToString() : $"{_min}..{_max}";
    }
}
